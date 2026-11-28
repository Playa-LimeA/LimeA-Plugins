const text = {
  zh: {
    features: '小镇功能',
    highlights: [
      ['在镇上相遇', '住客各有自己的家，也会在街道、公园、咖啡厅和店铺里碰面。状态卡显示当前角色的位置、动作和目的地。'],
      ['跟随住客日常', '角色按时间和偏好安排活动，也可以到其他住客家做客。收起小镇右栏后，日程仍会继续。'],
      ['看昼夜灯光', '住宅和公共场景的光线跟随顶部时钟，从晨光渐变到夜景。'],
    ],
    settings: '小镇设置',
    clock: '小镇时间',
    clockHint: '现实时间跟随设备时钟。虚拟时间里，现实 6 分钟等于小镇 1 小时。',
    real: '现实时间',
    virtual: '虚拟时间',
    loading: '正在读取时间设置…',
    saving: '正在保存…',
    readFailed: '暂时无法读取时间设置。',
    saveFailed: '暂时无法确认时间设置是否保存。',
    retry: '重试',
    usage: '使用方式',
    steps: [
      '在下方「入住角色」选好住客并保存。',
      '回到 Chat（聊天模式），从右栏的「+」菜单打开「陪伴小镇」。',
      '点击「地图」浏览其他地点，再用「回到角色」查看当前角色。',
    ],
    examples: ['「你现在在哪儿，在做什么？」', '「今天可以去谁家做客？」'],
  },
  en: {
    features: 'Town features',
    highlights: [
      ['Meet around town', 'Residents have their own homes and cross paths on the street, in the park, at the café, and in shops. The status card shows the current character’s location, activity, and destination.'],
      ['Follow daily life', 'Characters choose activities based on the time and their preferences. They can visit other residents, and their routines continue with the sidebar closed.'],
      ['Watch the light change', 'Lighting in homes and public spaces follows the clock at the top, from morning light to nightfall.'],
    ],
    settings: 'Town settings',
    clock: 'Town time',
    clockHint: 'Real time follows your device clock. In virtual time, 6 real minutes equal 1 town hour.',
    real: 'Real time',
    virtual: 'Virtual time',
    loading: 'Loading the time setting…',
    saving: 'Saving…',
    readFailed: 'Could not load the time setting.',
    saveFailed: 'Could not confirm that the time setting was saved.',
    retry: 'Try again',
    usage: 'How to get started',
    steps: [
      'Choose characters in Town residents below and save.',
      'Return to Chat and open Companion Town from the sidebar’s + menu.',
      'Open Map to browse other places, then choose Follow character to see where yours is.',
    ],
    examples: ['“Where are you now, and what are you doing?”', '“Who can we visit at home today?”'],
  },
};

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function section(key, label, icon) {
  const root = element('section', '', 'town-detail-section');
  const title = element('h2');
  title.id = `town-detail-${key}`;
  root.setAttribute('aria-labelledby', title.id);
  const iconSlot = element('span', '', 'town-detail-icon');
  iconSlot.dataset.icon = icon;
  iconSlot.setAttribute('aria-hidden', 'true');
  title.append(iconSlot, element('span', label));
  root.append(title);
  return root;
}

function readMode(snapshot) {
  const mode = snapshot?.mode;
  if (mode !== 'real' && mode !== 'virtual') throw new Error('Invalid town clock');
  return mode;
}

function mountClock(root, words, { signal, controls, command }) {
  const row = element('div', '', 'town-detail-clock-row');
  const caption = element('div', '', 'town-detail-clock-caption');
  caption.append(element('h3', words.clock), element('p', words.clockHint, 'muted'));
  const controlSlot = element('div', '', 'town-detail-clock-control');
  row.append(caption, controlSlot);
  const feedback = element('div', '', 'town-detail-clock-feedback');
  const status = element('p', '', 'muted');
  status.setAttribute('role', 'status');
  const retry = element('button', words.retry);
  retry.type = 'button';
  feedback.append(status, retry);
  root.append(row, feedback);

  const options = ['real', 'virtual'].map((value) => ({ value, label: words[value] }));
  let mode;
  let pending = false;
  let disposed = false;
  let retryAction;
  let dropdown;
  let native;

  function control() {
    return {
      type: 'select',
      label: words.clock,
      value: mode,
      disabled: pending,
      options,
      onValueChange: (value) => void syncMode(value),
    };
  }

  function render(message = '') {
    if (disposed || signal.aborted) return;
    status.textContent = message;
    feedback.hidden = !message;
    retry.hidden = !retryAction;
    if (!mode) return;
    if (dropdown) {
      dropdown.update(control());
      return;
    }
    if (!native) {
      try {
        dropdown = controls?.mount(controlSlot, control());
      } catch {
        // The native select keeps the setting available if host controls fail to mount.
      }
      if (dropdown) return;
      native = element('select');
      native.setAttribute('aria-label', words.clock);
      for (const { label, value } of options) native.add(new Option(label, value));
      native.addEventListener('change', () => void syncMode(native.value), { signal });
      controlSlot.append(native);
    }
    native.disabled = pending;
    native.value = mode;
  }

  async function syncMode(requested) {
    const saving = requested !== undefined;
    if (
      pending ||
      disposed ||
      signal.aborted ||
      (saving && ((requested !== 'real' && requested !== 'virtual') || requested === mode))
    ) return;
    pending = true;
    retryAction = undefined;
    render(saving ? words.saving : words.loading);
    let message = '';
    try {
      mode = readMode(await (saving
        ? command('set-town-clock', { mode: requested })
        : command('read-town-clock')));
    } catch {
      message = saving ? words.saveFailed : words.readFailed;
      retryAction = () => void syncMode(requested);
    } finally {
      pending = false;
      render(message);
    }
  }

  retry.addEventListener('click', () => retryAction?.(), { signal });
  void syncMode();
  return () => {
    disposed = true;
    dropdown?.destroy();
  };
}

export function mount(container, context) {
  const words = context.language.startsWith('zh') ? text.zh : text.en;
  const stylesheet = element('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = new URL('page.css', context.resourceBase).href;
  const root = element('div', '', 'town-detail');

  const features = section('features', words.features, 'blocks');
  const highlights = element('ul', '', 'town-detail-features');
  for (const [heading, copy] of words.highlights) {
    const item = element('li');
    item.append(element('h3', heading), element('p', copy, 'muted'));
    highlights.append(item);
  }
  features.append(highlights);

  const settings = section('settings', words.settings, 'link');

  const usage = section('usage', words.usage, 'message-square');
  const steps = element('ol', '', 'town-detail-steps');
  for (const step of words.steps) steps.append(element('li', step));
  const examples = element('blockquote', '', 'town-detail-examples');
  for (const example of words.examples) examples.append(element('p', example));
  usage.append(steps, examples);

  root.append(features, settings, usage);
  container.replaceChildren(stylesheet, root);

  const cleanupClock = mountClock(settings, words, context);
  const iconHandles = [];
  for (const slot of root.querySelectorAll('[data-icon]')) {
    const name = slot.dataset.icon;
    if (context.controls?.icons?.includes(name)) {
      try {
        iconHandles.push(context.controls.mount(slot, { type: 'icon', name, size: 18 }));
      } catch {
        slot.hidden = true;
      }
    } else slot.hidden = true;
  }

  return () => {
    cleanupClock();
    for (const handle of iconHandles) handle.destroy();
    stylesheet.remove();
    root.remove();
  };
}
