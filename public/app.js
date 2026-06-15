const socket = io();

const urlInput     = document.getElementById('urlInput');
const startBtn     = document.getElementById('startBtn');
const stopBtn      = document.getElementById('stopBtn');
const statusBox    = document.getElementById('statusBox');
const analysisLink = document.getElementById('analysisLink');

startBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!url) return;

  startBtn.disabled = true;
  startBtn.textContent = 'Bağlanıyor...';
  setStatus('', '');
  analysisLink.style.display = 'none';

  const res = await fetch('/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    setStatus('error', 'Hata: ' + (err.error || 'Bağlantı hatası'));
    startBtn.disabled = false;
    startBtn.textContent = 'Başlat';
  }
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  await fetch('/stop', { method: 'POST' }).catch(() => {});
});

socket.on('matchStatus', ({ status, homeName, awayName, message }) => {
  const teamLine = (homeName && awayName) ? `${homeName} - ${awayName}` : '';

  if (status === 'finished') {
    setStatus('finished', `Maç Bitti${teamLine ? ': ' + teamLine : ''}`);
    startBtn.disabled = false;
    startBtn.textContent = 'Başlat';
    analysisLink.style.display = 'none';
    stopBtn.style.display = 'none';
  } else if (status === 'not_started') {
    setStatus('not_started', `Maç henüz başlamadı, bekleniyor...${teamLine ? '\n' + teamLine : ''}`);
    analysisLink.style.display = 'inline-block';
    stopBtn.style.display = 'block';
    stopBtn.disabled = false;
    stopBtn.textContent = 'Maçtan Çık';
  } else if (status === 'running') {
    setStatus('running', `Maç devam ediyor${teamLine ? ': ' + teamLine : ''}`);
    startBtn.disabled = false;
    startBtn.textContent = 'Yenile';
    analysisLink.style.display = 'inline-block';
    stopBtn.style.display = 'block';
    stopBtn.disabled = false;
    stopBtn.textContent = 'Maçtan Çık';
  } else if (status === 'error') {
    setStatus('error', message || 'Bir hata oluştu');
    startBtn.disabled = false;
    startBtn.textContent = 'Başlat';
    stopBtn.style.display = 'none';
  } else if (status === 'stopped') {
    setStatus('', '');
    startBtn.disabled = false;
    startBtn.textContent = 'Başlat';
    urlInput.value = '';
    stopBtn.style.display = 'none';
    stopBtn.disabled = false;
    analysisLink.style.display = 'none';
  }
});

socket.on('matchEnd', () => {
  setStatus('finished', 'Maç Sona Erdi');
  analysisLink.style.display = 'inline-block';
  stopBtn.style.display = 'none';
});

function setStatus(type, text) {
  statusBox.className = 'status-box' + (type ? ' ' + type : '');
  statusBox.textContent = text;
  statusBox.style.display = text ? 'block' : 'none';
}
