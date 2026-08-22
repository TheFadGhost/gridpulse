let interval = null;
self.onmessage = (e) => {
  const msg = e.data;
  if (msg === 'start' && interval == null) {
    interval = setInterval(() => self.postMessage('tick'), 30);
  } else if (msg === 'stop' && interval != null) {
    clearInterval(interval);
    interval = null;
  }
};
