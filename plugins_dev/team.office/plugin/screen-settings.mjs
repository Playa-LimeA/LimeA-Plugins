import { loadScreenVideo } from './screen-video.mjs';

const messages = {
  zh: {
    hint: '选择一个本地 MP4（最多 32 MB）。办公室电视会静音循环播放同一段视频。',
    empty: '未选择视频',
    choose: '选择视频',
    replace: '替换视频',
    clear: '清除视频',
    checking: '正在检查视频…',
    saved: '已设置电视视频',
    cleared: '已清除电视视频',
    errors: {
      format: '请选择 MP4 视频文件。',
      size: '视频超过 32 MB，请选择较小的文件。',
      read: '无法读取视频文件，请重新选择。',
      decode: '此视频无法播放，请换一个 MP4 文件。',
      changed: '所选视频已变更，请重新选择。',
      storage: '无法更新电视视频，请重试。',
    },
  },
  en: {
    hint: 'Choose a local MP4 (up to 32 MB). Office TVs play the same video on a muted loop.',
    empty: 'No video selected',
    choose: 'Choose video',
    replace: 'Replace video',
    clear: 'Clear video',
    checking: 'Checking video…',
    saved: 'TV video set',
    cleared: 'TV video cleared',
    errors: {
      format: 'Choose an MP4 video file.',
      size: 'The video exceeds 32 MB. Choose a smaller file.',
      read: 'The file could not be read. Choose it again.',
      decode: 'This video cannot be played. Try another MP4 file.',
      changed: 'The selected video changed. Choose it again.',
      storage: 'The TV video could not be updated. Try again.',
    },
  },
};

export function mountScreenSettings(section, { language, resourceBase, signal, controls, command }) {
  const labels = language.toLowerCase().startsWith('zh') ? messages.zh : messages.en;
  const hint = document.createElement('p');
  hint.textContent = labels.hint;
  const row = document.createElement('div');
  row.className = 'office-screen-setting';
  const name = document.createElement('span');
  name.className = 'office-screen-name';
  const actions = document.createElement('div');
  actions.className = 'office-screen-actions';
  const chooseSlot = document.createElement('span');
  const clearSlot = document.createElement('span');
  actions.append(chooseSlot, clearSlot);
  row.append(name, actions);
  const status = document.createElement('p');
  status.className = 'office-screen-status';
  status.setAttribute('role', 'status');
  status.hidden = true;
  section.append(hint, row, status);

  let selection;
  let busy = true;
  const chooseControl = () => ({
    type: 'button', label: selection ? labels.replace : labels.choose, disabled: busy, onPress: choose,
  });
  const clearControl = () => ({
    type: 'button', label: labels.clear, variant: 'ghost', disabled: busy, onPress: clear,
  });
  const chooser = controls.mount(chooseSlot, chooseControl());
  const clearer = controls.mount(clearSlot, clearControl());

  function render() {
    if (signal.aborted) return;
    name.textContent = selection?.name ?? labels.empty;
    clearSlot.hidden = !selection;
    chooser.update(chooseControl());
    clearer.update(clearControl());
  }

  function feedback(message, error = false) {
    if (signal.aborted) return;
    status.textContent = message;
    status.hidden = !message;
    status.toggleAttribute('data-error', error);
  }

  async function choose() {
    if (busy) return;
    busy = true;
    feedback('');
    render();
    let file;
    try {
      const result = await command('screen-choose');
      if (result.canceled) return;
      if (result.error) {
        feedback(labels.errors[result.error] ?? labels.errors.storage, true);
        return;
      }
      file = result.candidate.file;
      feedback(labels.checking);
      try {
        const loaded = await loadScreenVideo(resourceBase, file, signal);
        loaded.dispose();
      } catch {
        feedback(labels.errors.decode, true);
        return;
      }
      const saved = await command('screen-save', file);
      if (saved.error) {
        feedback(labels.errors[saved.error] ?? labels.errors.storage, true);
        return;
      }
      selection = saved.selection;
      file = undefined;
      feedback(labels.saved);
    } catch {
      feedback(labels.errors.storage, true);
    } finally {
      if (file && !signal.aborted) await command('screen-discard', file).catch(() => {});
      busy = false;
      render();
    }
  }

  async function clear() {
    if (busy || !selection) return;
    busy = true;
    feedback('');
    render();
    try {
      ({ selection } = await command('screen-clear'));
      feedback(labels.cleared);
    } catch {
      feedback(labels.errors.storage, true);
    } finally {
      busy = false;
      render();
    }
  }

  render();
  void command('screen-state').then((result) => {
    selection = result.selection;
  }).catch(() => feedback(labels.errors.storage, true)).finally(() => {
    busy = false;
    render();
  });
  return () => {
    chooser.destroy();
    clearer.destroy();
  };
}
