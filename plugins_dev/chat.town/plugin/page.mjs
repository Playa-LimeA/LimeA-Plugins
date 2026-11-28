export function mount(container, { language }) {
  const example = document.createElement('p');
  example.textContent = language.startsWith('zh')
    ? '可以在聊天里问住客「你在哪？」或和她约好去公园看水。'
    : 'In chat, ask a resident where they are or suggest a walk to the park.';
  container.replaceChildren(example);
}
