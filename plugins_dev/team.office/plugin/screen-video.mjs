const mediaFile = /^tv-[0-9a-f-]{36}\.mp4$/;

export async function readScreenSelection(resourceBase, signal) {
  const response = await fetch(new URL('__data__/screen/current.json', resourceBase), { signal });
  if (!response.ok) throw new Error('Office screen settings are unavailable');
  const { selection } = await response.json();
  return mediaFile.test(selection?.file) ? selection : null;
}

export async function loadScreenVideo(resourceBase, file, signal) {
  if (!mediaFile.test(file)) throw new Error('Invalid office screen media');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(12000)]);
  const response = await fetch(new URL('__data__/screen/' + file, resourceBase), { signal: deadline });
  if (!response.ok) throw new Error('Office screen media is unavailable');
  const url = URL.createObjectURL(await response.blob());
  const video = document.createElement('video');
  video.defaultMuted = true;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = 'auto';

  function dispose() {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }

  try {
    deadline.throwIfAborted();
    await new Promise((resolve, reject) => {
      const listeners = new AbortController();
      function finish(error) {
        listeners.abort();
        deadline.removeEventListener('abort', cancel);
        if (error) reject(error);
        else resolve();
      }
      const cancel = () => finish(deadline.reason);
      deadline.addEventListener('abort', cancel, { once: true });
      video.addEventListener('loadeddata', () => finish(), { signal: listeners.signal });
      video.addEventListener('error', () => finish(new Error('Cannot decode office screen video')), {
        signal: listeners.signal,
      });
      video.src = url;
    });
    if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('Office screen media has no playable video');
    }
    return { video, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
