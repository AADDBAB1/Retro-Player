const $ = id => document.getElementById(id);
const v = $('v'), screen = $('screen'), osd = $('osd'), noise = $('noise');
let items = [], cur = -1, url = null, coverUrl = null, token = 0;
let ff = null, converting = false, label = '';

const AUDIO_EXT = /\.(mp3|flac|wav|m4a|aac|ogg|oga|opus|wma|weba)$/i;
const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|mov|mkv|avi|wmv|flv|m2ts|mts|mpg|mpeg|3gp)$/i;
const NEEDS_CONVERT = /\.(avi|wmv|flv|m2ts|mts|mpg|mpeg|wma)$/i;
const ext = n => (n.split('.').pop() || '').toLowerCase();
const clean = n => n.replace(/\.[^.]+$/, '');
const fmt = s => isFinite(s) ? Math.floor(s/60) + ':' + String(Math.floor(s%60)).padStart(2,'0') : '0:00';

/* ---- carregar pasta ou arquivos ---- */
$('open').onclick = $('emptyBtn').onclick = () => $('picker').click();
$('openFiles').onclick = $('emptyFilesBtn').onclick = () => $('filePicker').click();

function mapMediaFiles(fileList) {
  const files = [...fileList].filter(f => AUDIO_EXT.test(f.name) || VIDEO_EXT.test(f.name) || /^(audio|video)\//.test(f.type));
  files.sort((a,b) => (a.webkitRelativePath||a.name).localeCompare(b.webkitRelativePath||b.name, undefined, {numeric:true}));
  return files.map(f => ({
    file: f,
    kind: AUDIO_EXT.test(f.name) || f.type.startsWith('audio/') ? 'audio' : 'video',
    stage: null
  }));
}

function updateLibraryInfo(folderTitle) {
  if (folderTitle) $('folder').textContent = folderTitle;
  $('count').textContent = items.length
    ? items.length + (items.length === 1 ? ' arquivo' : ' arquivos')
    : 'Nenhuma mídia encontrada';
}

/* Abrir pasta (substitui a lista atual) */
$('picker').onchange = e => {
  const newItems = mapMediaFiles(e.target.files);
  items = newItems;
  cur = -1;
  const folderName = e.target.files[0]?.webkitRelativePath?.split('/')[0] || 'Biblioteca';
  updateLibraryInfo(folderName);
  renderList();
  if (items.length) play(0); else $('empty').style.display = 'grid';
  e.target.value = '';
};

/* Adicionar arquivos específicos (mantém os existentes e adiciona ao final) */
$('filePicker').onchange = e => {
  const added = mapMediaFiles(e.target.files);
  if (!added.length) {
    showOsd('NENHUM ARQUIVO SUPORTADO');
    e.target.value = '';
    return;
  }
  const startIndex = items.length;
  items.push(...added);
  updateLibraryInfo($('folder').textContent === 'Biblioteca' ? 'Arquivos selecionados' : null);
  renderList();
  if (cur === -1) {
    play(startIndex);
  } else {
    showOsd(`+${added.length} ${added.length === 1 ? 'ARQUIVO ADICIONADO' : 'ARQUIVOS ADICIONADOS'}`);
  }
  e.target.value = '';
};

function renderList(){
  const ol = $('ol'); ol.innerHTML = '';
  items.forEach((it,i) => {
    const li = document.createElement('li');
    li.innerHTML = '<button><span class="n"></span><span class="p"></span></button>';
    li.querySelector('.n').textContent = (it.kind === 'audio' ? '♪ ' : '') + clean(it.file.name);
    li.querySelector('.p').textContent = (it.file.webkitRelativePath || '').split('/').slice(1,-1).join(' / ');
    li.firstChild.onclick = () => play(i);
    if (i === cur) li.className = 'cur';
    ol.appendChild(li);
  });
  if (items.length) $('hint').style.display = 'none';
}

function setSrc(blob){
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(blob);
  v.src = url;
  v.play().catch(()=>{});
}

function play(i){
  if (i < 0 || i >= items.length) return;
  abortConvert();
  cur = i;
  const it = items[i]; it.stage = null;
  $('empty').style.display = 'none';
  showNoise();
  showOsd((it.kind === 'audio' ? '♪ ' : '▶ ') + clean(it.file.name));
  [...$('ol').children].forEach((li,k) => li.classList.toggle('cur', k === i));
  $('ol').children[i]?.scrollIntoView({block:'nearest'});
  setArt(it);
  if (NEEDS_CONVERT.test(it.file.name)) advance(it);
  else if (ext(it.file.name) === 'mkv') setSrc(it.file.slice(0, it.file.size, 'video/webm'));
  else setSrc(it.file);
}

/* ---- conversão (ffmpeg.wasm) para formatos que o navegador não toca ---- */
const loadScript = src => new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = src; s.onload = res; s.onerror = () => rej(new Error('offline'));
  document.head.appendChild(s);
});

async function getFF(){
  if (ff) return ff;
  const B = 'https://cdn.jsdelivr.net/npm/';
  if (!window.FFmpegWASM){
    await loadScript(B + '@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js');
    await loadScript(B + '@ffmpeg/util@0.12.1/dist/umd/index.js');
  }
  const {FFmpeg} = FFmpegWASM, {toBlobURL} = FFmpegUtil;
  const core = B + '@ffmpeg/core@0.12.6/dist/umd/';
  const f = new FFmpeg();
  f.on('progress', ({progress}) => {
    if (converting && isFinite(progress)) showOsd(label + ' ' + Math.min(100, Math.max(0, Math.round(progress*100))) + '%', true);
  });
  await f.load({
    coreURL: await toBlobURL(core + 'ffmpeg-core.js', 'text/javascript'),
    wasmURL: await toBlobURL(core + 'ffmpeg-core.wasm', 'application/wasm'),
    classWorkerURL: await toBlobURL(B + '@ffmpeg/ffmpeg@0.12.10/dist/umd/814.ffmpeg.js', 'text/javascript')
  });
  return ff = f;
}

function abortConvert(){
  token++;
  if (converting && ff){ try{ ff.terminate(); }catch(e){} ff = null; }
  converting = false;
}

/* vídeo: tenta só trocar o contêiner (rápido); se não tocar, recodifica. Áudio: recodifica. */
async function advance(it){
  if (it.stage === 'encode'){ showOsd('FORMATO NÃO SUPORTADO'); return; }
  it.stage = (it.kind === 'audio' || it.stage === 'remux') ? 'encode' : 'remux';
  convert(it, it.stage);
}

async function convert(it, mode){
  const my = token; converting = true;
  const isA = it.kind === 'audio', inn = 'in.' + ext(it.file.name), out = isA ? 'out.m4a' : 'out.mp4';
  try{
    label = mode === 'remux' ? 'CONVERTENDO' : 'RECODIFICANDO';
    showOsd(ff ? label + '…' : 'BAIXANDO CONVERSOR…', true);
    const f = await getFF();
    if (my !== token) return;
    showOsd(label + '…', true);
    await f.writeFile(inn, new Uint8Array(await it.file.arrayBuffer()));
    const args = isA ? ['-i', inn, '-vn', '-c:a', 'aac', '-b:a', '192k', out]
      : mode === 'remux' ? ['-i', inn, '-c', 'copy', '-movflags', '+faststart', out]
      : ['-i', inn, '-vf', "scale='min(854,iw)':-2", '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
         '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out];
    const code = await f.exec(args);
    if (my !== token) return;
    if (code !== 0) throw new Error('ffmpeg ' + code);
    const data = await f.readFile(out);
    await f.deleteFile(inn); await f.deleteFile(out);
    converting = false;
    showOsd((isA ? '♪ ' : '▶ ') + clean(it.file.name));
    setSrc(new Blob([data.buffer], {type: isA ? 'audio/mp4' : 'video/mp4'}));
  }catch(err){
    if (my !== token) return;
    converting = false;
    if (err.message === 'offline') return showOsd('CONVERSOR PRECISA DE INTERNET');
    if (mode === 'remux') return advance(it);
    showOsd('FALHA NA CONVERSÃO');
  }
}

/* ---- capa e tags (ID3 do MP3, imagem do FLAC) ---- */
const rd = async (f,a,b) => new Uint8Array(await f.slice(a,b).arrayBuffer());
const u32 = (b,o) => ((b[o]<<24)|(b[o+1]<<16)|(b[o+2]<<8)|b[o+3])>>>0;
const sync = (b,o) => (b[o]<<21)|(b[o+1]<<14)|(b[o+2]<<7)|b[o+3];
const sniff = b => b[0] === 0x89 ? 'image/png' : b[0] === 0x47 ? 'image/gif' : 'image/jpeg';
const dec = (b,enc) => new TextDecoder(['iso-8859-1','utf-16','utf-16be','utf-8'][enc] || 'utf-8')
  .decode(b).replace(/\0+$/,'').replace(/^\uFEFF/,'');
const skipZero = (d,q,wide) => { const w = wide ? 2 : 1;
  while (q < d.length && !(d[q] === 0 && (!wide || d[q+1] === 0))) q += w; return q + w; };

async function readMeta(file){
  const h = await rd(file, 0, 10), meta = {};
  if (String.fromCharCode(h[0],h[1],h[2]) === 'ID3'){
    const ver = h[3], b = await rd(file, 10, 10 + sync(h,6));
    let p = h[5] & 0x40 ? (ver === 4 ? sync(b,0) : u32(b,0) + 4) : 0;
    const idl = ver === 2 ? 3 : 4, hl = ver === 2 ? 6 : 10;
    while (p + hl <= b.length && b[p] !== 0){
      const id = String.fromCharCode(...b.subarray(p, p+idl));
      const sz = ver === 2 ? (b[p+3]<<16)|(b[p+4]<<8)|b[p+5] : ver === 4 ? sync(b,p+4) : u32(b,p+4);
      const d = b.subarray(p+hl, p+hl+sz); p += hl + sz;
      const txt = () => dec(d.subarray(1), d[0]);
      if (id === 'TIT2' || id === 'TT2') meta.title = txt();
      else if (id === 'TPE1' || id === 'TP1') meta.artist = txt();
      else if (id === 'TALB' || id === 'TAL') meta.album = txt();
      else if ((id === 'APIC' || id === 'PIC') && !meta.pic){
        const enc = d[0]; let q = 1;
        q = ver === 2 ? q + 3 : skipZero(d, q, false);
        q++;
        q = skipZero(d, q, enc === 1 || enc === 2);
        const img = d.subarray(q);
        if (img.length > 100) meta.pic = new Blob([img], {type: sniff(img)});
      }
    }
  } else if (String.fromCharCode(h[0],h[1],h[2],h[3]) === 'fLaC'){
    let p = 4, last = false;
    while (!last && p < file.size){
      const bh = await rd(file, p, p+4);
      last = !!(bh[0] & 0x80);
      const t = bh[0] & 0x7f, len = (bh[1]<<16)|(bh[2]<<8)|bh[3];
      if (t === 6){
        const b = await rd(file, p+4, p+4+len);
        let q = 4; q += 4 + u32(b,q); q += 4 + u32(b,q); q += 16;
        const n = u32(b,q), img = b.subarray(q+4, q+4+n);
        meta.pic = new Blob([img], {type: sniff(img)});
        break;
      }
      p += 4 + len;
    }
  }
  return meta;
}

async function setArt(it){
  $('art').style.display = it.kind === 'audio' ? 'flex' : 'none';
  if (it.kind !== 'audio') return;
  $('ttl').textContent = clean(it.file.name);
  $('sub').textContent = '';
  $('cover').hidden = true; $('nocover').hidden = false;
  const my = cur;
  const meta = await readMeta(it.file).catch(() => ({}));
  if (my !== cur) return;
  if (meta.title) $('ttl').textContent = meta.title;
  $('sub').textContent = [meta.artist, meta.album].filter(Boolean).join('\n');
  if (coverUrl){ URL.revokeObjectURL(coverUrl); coverUrl = null; }
  if (meta.pic){
    coverUrl = URL.createObjectURL(meta.pic);
    $('cover').src = coverUrl;
    $('cover').hidden = false; $('nocover').hidden = true;
  }
}

/* ---- controles ---- */
const toggle = () => v.paused ? v.play() : v.pause();
$('play').onclick = toggle;
$('prev').onclick = () => play(cur - 1);
$('next').onclick = () => play(cur + 1);
v.onclick = toggle;
v.onplay = v.onpause = () => {
  $('play').textContent = v.paused ? '▶' : '⏸';
  $('led').classList.toggle('on', !v.paused);
};
v.onended = () => { if (cur + 1 < items.length) play(cur + 1); };
v.ontimeupdate = () => {
  if (!seeking) $('seek').value = v.duration ? v.currentTime / v.duration * 1000 : 0;
  $('time').textContent = fmt(v.currentTime) + ' / ' + fmt(v.duration);
};
let seeking = false;
$('seek').oninput = e => { seeking = true; if (v.duration) v.currentTime = e.target.value / 1000 * v.duration; };
$('seek').onchange = () => seeking = false;
$('vol').oninput = e => { v.volume = e.target.value; };
v.onerror = () => { const it = items[cur]; if (it && !converting) advance(it); };

/* ---- CRT ---- */
$('crt').onclick = e => {
  const on = screen.classList.toggle('crt-on');
  e.currentTarget.setAttribute('aria-pressed', on);
};
$('int').oninput = e => document.documentElement.style.setProperty('--crt', e.target.value);
$('fs').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await $('tv').requestFullscreen();
  } catch (err) {
    showOsd('NÃO FOI POSSÍVEL ABRIR TELA CHEIA');
  }
};
document.addEventListener('fullscreenchange', () => {
  $('fs').textContent = document.fullscreenElement === $('tv') ? 'Sair da tela cheia' : 'Tela cheia';
});

/* Mantém os controles visíveis por 4 segundos após cada interação */
const tv = $('tv');
let fullscreenMenuTimer = null;

function showFullscreenMenu() {
  if (document.fullscreenElement !== tv) return;
  tv.classList.remove('fs-idle');
  clearTimeout(fullscreenMenuTimer);
  fullscreenMenuTimer = setTimeout(() => {
    if (document.fullscreenElement === tv) tv.classList.add('fs-idle');
  }, 4000);
}

['pointermove', 'pointerdown', 'touchstart', 'keydown'].forEach(eventName => {
  tv.addEventListener(eventName, showFullscreenMenu, {passive:true});
});

document.addEventListener('fullscreenchange', () => {
  clearTimeout(fullscreenMenuTimer);
  tv.classList.remove('fs-idle');
  if (document.fullscreenElement === tv) showFullscreenMenu();
});

/* ---- texto na tela e ruído ---- */
let osdT;
function showOsd(t, sticky){
  osd.textContent = t;
  osd.classList.add('show');
  clearTimeout(osdT);
  if (!sticky) osdT = setTimeout(() => osd.classList.remove('show'), 2500);
}
const nctx = noise.getContext('2d');
function showNoise(){
  noise.classList.add('on');
  let n = 0;
  const id = setInterval(() => {
    const d = nctx.createImageData(160,100);
    for (let k = 0; k < d.data.length; k += 4){ const g = Math.random()*255; d.data[k]=d.data[k+1]=d.data[k+2]=g; d.data[k+3]=255; }
    nctx.putImageData(d,0,0);
    if (++n > 8){ clearInterval(id); noise.classList.remove('on'); }
  }, 40);
}

/* ---- atalhos ---- */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === ' ') { e.preventDefault(); toggle(); }
  else if (k === 'arrowright') v.currentTime += 5;
  else if (k === 'arrowleft') v.currentTime -= 5;
  else if (k === 'n') play(cur + 1);
  else if (k === 'p') play(cur - 1);
  else if (k === 'f') $('fs').click();
});