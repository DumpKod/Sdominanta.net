// Свой плеер по ключу API: поток SoundCloud кусками HLS → MediaSource → <audio> → анализатор.
// Адреса кусков даёт /music/stream/{id} (Worker берёт плейлист по ключу), звук браузер берёт у CDN SoundCloud сам:
// SoundCloud разрешает его чтение с чужих страниц (проверено хранителем 19.10), поэтому анализатор слышит настоящий звук.
// Блоб MediaSource — наш, так что Web Audio не получает тишину, как от чужого адреса без CORS.
// Буфер держится на AHEAD секунд вперёд, сыгранное старше BEHIND отпускается. Перемотка и луп — с нужного куска.
// Подписи адресов временные: на 403 плейлист берётся заново (load), один раз на кусок.

/** Сколько секунд звука держать впереди и сколько сыгранного оставлять. */
export const AHEAD = 30;
export const BEHIND = 30;

/** MediaSource этого браузера: обычный или ManagedMediaSource (iPhone с iOS 17.1). null — свой плеер невозможен. */
export function mediaSource(mime) {
  const MS = window.ManagedMediaSource || window.MediaSource;
  return MS && MS.isTypeSupported(mime) ? MS : null;
}

/** Номер куска, в котором момент t (сек): куски [адрес, длительность] подряд от нуля. */
export function segmentAt(segments, t) {
  let at = 0;
  for (let i = 0; i < segments.length; i++) {
    at += segments[i][1];
    if (t < at) return i;
  }
  return Math.max(0, segments.length - 1);
}

/** Начало куска i в секундах. */
export function segmentStart(segments, i) {
  let at = 0;
  for (let k = 0; k < i; k++) at += segments[k][1];
  return at;
}

/** Конец буфера, в котором момент t; t не в буфере — t. */
function bufferedEnd(b, t) {
  for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.1 && t < b.end(i)) return b.end(i);
  return t;
}

export class Feed {
  /**
   * audio — элемент <audio>; load() — ответ /music/stream (mime, map, segments, duration) или null; спрашивается сразу
   * и заново, когда подписи истекли. onFail(text) — поток не идёт. MediaSource ставится в audio.src сразу,
   * ещё в нажатии ▶, чтобы браузер разрешил звук; куски приходят следом.
   */
  constructor(audio, load, onFail) {
    this.audio = audio;
    this.load = load;
    this.onFail = onFail;
    this.src = null;
    this.next = 0;
    this.gen = 0;
    this.busy = false;
    this.dead = false;
    this.sb = null;
    const MS = window.ManagedMediaSource || window.MediaSource;
    this.ms = new MS();
    // ManagedMediaSource открывается только при выключенном AirPlay (иначе нужен второй источник без MSE).
    if (window.ManagedMediaSource && this.ms instanceof window.ManagedMediaSource) audio.disableRemotePlayback = true;
    const opened = new Promise((ok) => this.ms.addEventListener('sourceopen', ok, { once: true }));
    audio.src = URL.createObjectURL(this.ms);
    const kick = () => this.pump();
    audio.addEventListener('timeupdate', kick);
    audio.addEventListener('seeking', () => this.seek());
    audio.addEventListener('playing', kick);
    this.ms.addEventListener('startstreaming', kick); // ManagedMediaSource: система просит данных
    Promise.all([opened, load()]).then(([, first]) => {
      if (!first) return this.fail('нет потока');
      if (!mediaSource(first.mime)) return this.fail('браузер не собирает ' + first.mime);
      this.open(first);
    }, (e) => this.fail(String(e && e.message || e)));
  }

  fail(text) {
    if (this.dead) return;
    this.dead = true;
    this.onFail(text);
  }

  open(first) {
    this.src = first;
    const sb = (this.sb = this.ms.addSourceBuffer(first.mime));
    // mp3 не несёт меток времени в кусках: время ставим сами (sequence + timestampOffset). fMP4 несёт свои.
    this.seq = !/mp4/.test(first.mime);
    if (this.seq) sb.mode = 'sequence';
    if (first.duration > 0) this.ms.duration = first.duration;
    this.inited = false;
    this.pump();
  }

  /** Перемотка (и луп, который перематывает в ноль): если места нет в буфере — качать с нужного куска. */
  seek() {
    if (!this.sb) return;
    const t = this.audio.currentTime;
    if (bufferedEnd(this.sb.buffered, t) > t) return;
    this.gen++;
    this.next = segmentAt(this.src.segments, t);
    if (this.sb.updating) try { this.sb.abort(); } catch {}
    this.pump();
  }

  wait() {
    return new Promise((ok, no) => {
      const sb = this.sb;
      const done = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', bad); ok(); };
      const bad = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', bad); no(new Error('append')); };
      sb.addEventListener('updateend', done);
      sb.addEventListener('error', bad);
    });
  }

  async get(i) {
    let u = i < 0 ? this.src.map : this.src.segments[i][0];
    let r = await fetch(u, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (r.status === 403 || r.status === 404 || r.status === 410) {
      const fresh = await this.load(); // подписи истекли: новый плейлист той же нарезки
      if (fresh && fresh.segments.length === this.src.segments.length) {
        this.src = fresh;
        u = i < 0 ? fresh.map : fresh.segments[i][0];
        r = await fetch(u, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
      }
    }
    if (!r.ok) throw new Error('fetch ' + r.status);
    return r.arrayBuffer();
  }

  async append(buf, start) {
    const sb = this.sb;
    if (this.seq && start != null) sb.timestampOffset = start;
    try {
      sb.appendBuffer(buf);
    } catch (e) {
      if (e.name !== 'QuotaExceededError') throw e;
      await this.trim(5); // браузер просит места: отпустить сыгранное почти целиком и повторить
      sb.appendBuffer(buf);
    }
    await this.wait();
  }

  async trim(keep) {
    const b = this.sb.buffered, t = this.audio.currentTime;
    if (!b.length || t - b.start(0) <= keep) return;
    this.sb.remove(0, t - keep);
    await this.wait();
  }

  async pump() {
    if (this.busy || this.dead || !this.sb || this.ms.readyState === 'closed') return;
    this.busy = true;
    try {
      for (;;) {
        const gen = this.gen, segs = this.src.segments;
        if (this.next >= segs.length) {
          if (this.ms.readyState === 'open' && !this.sb.updating) this.ms.endOfStream();
          break;
        }
        const t = this.audio.currentTime;
        if (bufferedEnd(this.sb.buffered, t) - t > AHEAD) break;
        if (this.src.map && !this.inited) {
          await this.append(await this.get(-1), null);
          this.inited = true;
        }
        const i = this.next, data = await this.get(i);
        if (gen !== this.gen) continue; // пока качали, перемотали — этот кусок уже не нужен
        if (this.sb.buffered.length && t - this.sb.buffered.start(0) > BEHIND + 10) await this.trim(BEHIND);
        await this.append(data, segmentStart(segs, i));
        if (gen === this.gen) this.next = i + 1;
      }
    } catch (e) {
      this.fail(String(e && e.message || e));
    } finally {
      this.busy = false;
    }
  }
}
