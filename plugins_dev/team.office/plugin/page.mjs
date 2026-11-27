const copy = {
  zh: {
    usage: '打开方式',
    path: '进入「团队」，点击聊天标题旁的办公楼图标，办公室会在右栏打开。',
    features: '插件功能',
    items: [
      ['楼栋图切层', '点楼层标题展开楼栋图，在招待大厅、通用办公层和总裁层之间切换。'],
      ['固定工位', '普通成员每层最多 12 位，工位排满后自动增加楼层。指定助理坐在总裁层的助理办公室。'],
      ['成员状态与活动', '点头像查看成员正在做什么、在哪个区域。待命时，成员也会走去水吧、休闲区或窗边长椅。'],
      ['三维视角', '拖动画面旋转，滚动鼠标滚轮缩放，点「复位」回到默认视角。'],
    ],
  },
  en: {
    usage: 'How to open',
    path: 'Go to Team and click the building icon next to the chat title to open the office in the right sidebar.',
    features: 'Features',
    items: [
      ['Switch floors', 'Open the building map from the floor title and choose the lobby, a standard floor, or the executive floor.'],
      ['Assigned desks', 'Each standard floor seats up to 12 members. Space expands as the team grows, and the designated assistant sits on the executive floor.'],
      ['Member status and activity', 'Click a portrait to see the member’s current activity and location. Available members may walk to the coffee bar, lounge, or window bench.'],
      ['Interactive 3D view', 'Drag to rotate, scroll to zoom, and select Reset to return to the default view.'],
    ],
  },
};

const featureIcons = ['list-tree', 'circle-check', 'message-square', 'refresh-cw'];

function element(tag, text) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}

export function mount(container, { language, resourceBase, signal, controls }) {
  signal.throwIfAborted();
  const labels = language.toLowerCase().startsWith('zh') ? copy.zh : copy.en;
  const styles = element('link');
  styles.rel = 'stylesheet';
  styles.href = new URL('page.css', resourceBase).href;
  const root = element('div');
  root.className = 'office-detail';
  const slots = [];

  function addIcon(parent, name) {
    if (!controls?.icons?.includes(name)) return;
    const slot = element('span');
    slot.className = 'office-detail-icon';
    parent.prepend(slot);
    slots.push([slot, name]);
  }

  function section(title, icon) {
    const group = element('section');
    const heading = element('h2', title);
    addIcon(heading, icon);
    group.append(heading);
    root.append(group);
    return group;
  }

  section(labels.usage, 'external-link').append(element('p', labels.path));
  const features = element('ul');
  for (const [index, [title, description]] of labels.items.entries()) {
    const row = element('li');
    addIcon(row, featureIcons[index]);
    const content = element('div');
    content.append(element('h3', title), element('p', description));
    row.append(content);
    features.append(row);
  }
  section(labels.features, 'blocks').append(features);
  container.append(styles, root);
  const icons = slots.map(([slot, name]) => controls.mount(slot, { type: 'icon', name, size: 18 }));

  return () => {
    for (const icon of icons) icon.destroy();
    root.remove();
    styles.remove();
  };
}
