const text = {
  zh: {
    title: '小镇时间',
    hint: '现实时间跟随设备时钟。虚拟时间里，现实 6 分钟等于小镇 1 小时。',
    real: '现实时间',
    virtual: '虚拟时间',
    saving: '正在保存…',
    failed: '暂时无法确认时间设置，请重试。',
    example: '可以在聊天里问住客「你在哪？」或和她约好去公园看水。',
  },
  en: {
    title: 'Town time',
    hint: 'Real time follows your device clock. In virtual time, 6 real minutes equal 1 town hour.',
    real: 'Real time',
    virtual: 'Virtual time',
    saving: 'Saving…',
    failed: 'Could not confirm the time setting. Try again.',
    example: 'In chat, ask a resident where they are or suggest a walk to the park.',
  },
};

function readMode(snapshot) {
  const mode = snapshot?.mode;
  if (mode !== 'real' && mode !== 'virtual') throw new Error('Invalid town clock');
  return mode;
}

export async function mount(container, { language, resourceBase, signal, controls, command }) {
  const words = language.startsWith('zh') ? text.zh : text.en;
  const options = ['real', 'virtual'].map((value) => ({ value, label: words[value] }));
  let mode = readMode(await command('read-town-clock'));
  signal.throwIfAborted();
  let pending = false;

  const styles = document.createElement('link');
  styles.rel = 'stylesheet';
  styles.href = new URL('town.css', resourceBase).href;
  const section = document.createElement('section');
  section.className = 'town-clock-settings';
  section.setAttribute('aria-labelledby', 'town-clock-settings-title');
  const row = document.createElement('div');
  row.className = 'town-clock-settings-row';
  const copy = document.createElement('div');
  copy.className = 'town-clock-settings-copy';
  const title = document.createElement('h2');
  title.id = 'town-clock-settings-title';
  title.textContent = words.title;
  const hint = document.createElement('p');
  hint.textContent = words.hint;
  copy.append(title, hint);
  const slot = document.createElement('div');
  row.append(copy, slot);
  const status = document.createElement('p');
  status.className = 'town-clock-settings-status';
  status.setAttribute('role', 'status');
  status.hidden = true;
  section.append(row, status);
  const example = document.createElement('p');
  example.className = 'town-clock-example';
  example.textContent = words.example;
  container.replaceChildren(styles, section, example);

  function control() {
    return {
      type: 'select',
      label: words.title,
      value: mode,
      disabled: pending,
      options,
      onValueChange(value) { void selectMode(value); },
    };
  }

  const dropdown = controls?.mount(slot, control());
  const native = dropdown ? null : document.createElement('select');
  if (native) {
    native.setAttribute('aria-label', words.title);
    for (const { label, value } of options) native.add(new Option(label, value));
    native.addEventListener('change', () => void selectMode(native.value), { signal });
    slot.append(native);
  }

  function render(message = '') {
    if (signal.aborted) return;
    if (native) {
      native.disabled = pending;
      native.value = mode;
    } else dropdown.update(control());
    status.textContent = message;
    status.hidden = !message;
  }

  async function selectMode(value) {
    if (signal.aborted || pending || value === mode || (value !== 'real' && value !== 'virtual')) return;
    pending = true;
    render(words.saving);
    let message = '';
    try {
      mode = readMode(await command('set-town-clock', { mode: value }));
    } catch {
      message = words.failed;
    } finally {
      pending = false;
      render(message);
    }
  }

  render();
  return () => {
    dropdown?.destroy();
    styles.remove();
    section.remove();
    example.remove();
  };
}
