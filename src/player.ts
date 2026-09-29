import Hls from "hls.js";
import { isMixedContent } from "./config";
import type { Channel } from "./types";

/**
 * Сколько подряд сетевых сбоев переживаем, прежде чем сдаться. Без предела
 * заблокированный или мёртвый поток крутит переподключение вечно, показывая
 * один и тот же тост и не давая пользователю понять, что канал не работает.
 */
const MAX_NETWORK_RETRIES = 3;

/**
 * Плеер поверх <video>: hls.js для .m3u8, нативные механизмы для остальных.
 * Управление воспроизведением/громкостью/PiP — через нативный media API
 * (юнит-тесты покрывают чистую логику: neighborIndex, see tests/player-logic).
 */
export class Player {
  private video: HTMLVideoElement;
  private hls: Hls | null = null;
  private currentUrl: string | null = null;
  private toast: (msg: string) => void;
  /** Вызывается, когда hls сообщит о манифесте/уровне/дорожках (для UI). */
  private onHlsState: (() => void) | null;
  /** Вызывается при фатальной ошибке потока (для retry-кнопки UI). */
  private onFatalError: (() => void) | null;
  /**
   * Вызывается на каждый загруженный сегмент — на этом строится запись эфира.
   * `payload` живёт только внутри вызова: hls.js отдаёт буфер в воркер
   * трансфером, после чего исходный ArrayBuffer отсоединяется. Сохранять
   * нужно копию.
   */
  private onFragment: ((payload: ArrayBuffer, isInit: boolean) => void) | null = null;
  /** Сетевые сбои подряд; сбрасывается, как только пошли данные. */
  private networkRetries = 0;

  constructor(
    video: HTMLVideoElement,
    toast: (msg: string) => void,
    onHlsState?: () => void,
    onFatalError?: () => void,
  ) {
    this.video = video;
    this.toast = toast;
    this.onHlsState = onHlsState ?? null;
    this.onFatalError = onFatalError ?? null;
  }

  /**
   * Подписаться на загружаемые сегменты. Подписка переживает смену канала:
   * обработчик вешается на каждый новый hls-инстанс.
   */
  setFragmentListener(cb: (payload: ArrayBuffer, isInit: boolean) => void): void {
    this.onFragment = cb;
  }

  /** Повесить обработчик сегментов на текущий hls-инстанс. */
  private attachFragmentListener(): void {
    this.hls?.on(Hls.Events.FRAG_LOADED, (_e, data) => {
      this.networkRetries = 0; // данные пошли — прошлые сбои не в счёт
      this.onFragment?.(data.payload, data.frag.sn === "initSegment");
    });
  }

  /**
   * Играть канал. null — попытка начата, строка — причина отказа (её и
   * показывает вызывающий; сам плеер про это не тостит, чтобы сообщения
   * не наслаивались).
   */
  play(channel: Channel): string | null {
    const url = channel.url;
    if (this.currentUrl === url && !this.video.paused) return null;
    // Браузер блокирует http-поток на https-странице ещё до сети, и снаружи
    // это выглядит как обычный сетевой сбой — плеер уходил в бесконечное
    // переподключение вместо того, чтобы назвать причину.
    if (isMixedContent(window.location.href, url)) {
      return "Канал отдаётся по http — браузер блокирует его на https-странице";
    }
    this.stop();
    this.networkRetries = 0;

    const isHls = /\.m3u8(\?|$)/i.test(url) || /[?&]type=m3u8/i.test(url);
    const isDash = /\.mpd(\?|$)/i.test(url);

    if (isHls && Hls.isSupported()) {
      this.hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      this.hls.loadSource(url);
      this.hls.attachMedia(this.video);
      this.hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        // Автовосстановление по типу ошибки (рекомендации hls.js):
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (!shouldRetryNetwork(++this.networkRetries)) {
            console.debug(`[iptv-hub] hls network error: ${data.details}, сдаёмся`);
            this.toast("Поток не отвечает — попробуйте повтор или другой канал");
            this.onFatalError?.();
            return;
          }
          // сеть/манифест: пробуем перезапустить загрузку
          console.debug(`[iptv-hub] hls network error: ${data.details}, restarting load`);
          this.hls?.startLoad();
          this.toast(`Сбой сети — переподключаемся (${this.networkRetries}/${MAX_NETWORK_RETRIES})…`);
          return;
        }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          console.debug(`[iptv-hub] hls media error: ${data.details}, recovering`);
          this.hls?.recoverMediaError();
          this.toast("Сбой декодирования — восстанавливаемся…");
          return;
        }
        // остальное — фатально: предлагаем ручной retry
        this.toast(`Ошибка потока: ${data.details ?? "unknown"}`);
        this.onFatalError?.();
      });
      const notify = (): void => this.onHlsState?.();
      this.hls.on(Hls.Events.MANIFEST_PARSED, notify);
      this.hls.on(Hls.Events.LEVEL_SWITCHED, notify);
      this.hls.on(Hls.Events.LEVEL_UPDATED, notify);
      this.hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, notify);
      this.hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, notify);
      this.attachFragmentListener();
    } else if (isDash) {
      return "MPEG-DASH не поддерживается в MVP (см. ROADMAP)";
    } else {
      // http progressive (mp4) или нативный HLS в Safari/iOS
      this.video.src = url;
    }

    this.currentUrl = url;
    this.video.play().catch(() => {
      // автоплей с звуком может быть заблокирован — юзер нажмёт play вручную
    });
    return null;
  }

  /** Пауза/продолжить. Возвращает true после вызова — на паузе или играет. */
  togglePause(): void {
    if (this.video.paused) {
      this.video.play().catch(() => {
        // автоплей заблокирован — юзер повторит клик
      });
    } else {
      this.video.pause();
    }
  }

  /** Громкость 0..1 (мьют отдельно). */
  setVolume(v: number): void {
    this.video.volume = Math.min(1, Math.max(0, v));
    if (this.video.muted && this.video.volume > 0) this.video.muted = false;
  }

  getVolume(): number {
    return this.video.muted ? 0 : this.video.volume;
  }

  toggleMute(): void {
    this.video.muted = !this.video.muted;
  }

  /** Picture-in-Picture. False — API недоступен или отказано. */
  async togglePip(): Promise<boolean> {
    if (!document.pictureInPictureEnabled) {
      this.toast("PiP не поддерживается этим браузером");
      return false;
    }
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await this.video.requestPictureInPicture();
      }
      return true;
    } catch {
      this.toast("Не удалось открыть плавающее окно");
      return false;
    }
  }

  stop(): void {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video.removeAttribute("src");
    this.video.load();
    this.currentUrl = null;
  }

  // ---- Качество / дорожки (работают только когда поток через hls.js) ----

  /** Живой hls-инстанс или null (нативный playback — управление недоступно). */
  getHls(): Hls | null {
    return this.hls;
  }

  /** Выбрать уровень качества; -1 = Auto. */
  setLevel(index: number): void {
    if (this.hls) this.hls.currentLevel = index;
  }

  /** Выбрать аудиодорожку. */
  setAudioTrack(index: number): void {
    if (this.hls) this.hls.audioTrack = index;
  }

  /** Выбрать субтитры; -1 = выключены. */
  setSubtitleTrack(index: number): void {
    if (this.hls) this.hls.subtitleTrack = index;
  }

  /** Перезапустить текущий поток с нуля (retry-кнопка). */
  retry(): void {
    const url = this.currentUrl;
    if (!url) return;
    const isHls = /\.m3u8(\?|$)/i.test(url) || /[?&]type=m3u8/i.test(url);
    const channel: Channel = { url, name: "", normalizedName: "", tvgId: null, logo: null, group: "", quality: null, catchupDays: 0, catchupSource: null };
    this.stop();
    this.networkRetries = 0; // ручной повтор даёт потоку новый лимит попыток
    if (isHls && Hls.isSupported()) {
      this.hls = new Hls({ enableWorker: true, lowLatencyMode: false });
      this.hls.loadSource(url);
      this.hls.attachMedia(this.video);
      this.hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          this.toast(`Ошибка потока: ${data.details ?? "unknown"}`);
          this.onFatalError?.();
        }
      });
      const notify = (): void => this.onHlsState?.();
      this.hls.on(Hls.Events.MANIFEST_PARSED, notify);
      this.hls.on(Hls.Events.LEVEL_SWITCHED, notify);
      this.hls.on(Hls.Events.LEVEL_UPDATED, notify);
      this.attachFragmentListener();
    } else {
      this.video.src = url;
    }
    this.currentUrl = url;
    this.video.play().catch(() => undefined);
    void channel;
  }
}

/**
 * Стоит ли ещё раз перезапускать загрузку после сетевого сбоя.
 * Вынесено из класса, чтобы предел попыток покрывался тестом без DOM и hls.js.
 */
export function shouldRetryNetwork(consecutiveFailures: number): boolean {
  return consecutiveFailures <= MAX_NETWORK_RETRIES;
}

/**
 * Соседний индекс по списку каналов с зацикливанием.
 * Чистая функция — покрывается юнит-тестами.
 * Возвращает null, если список пуст.
 */
export function neighborIndex(
  current: number,
  length: number,
  step: 1 | -1,
): number | null {
  if (length <= 0) return null;
  return (((current + step) % length) + length) % length;
}

/**
 * Цель перемотки ±сек. Чистая функция с валидацией границ.
 * live-поток не перематывается — возвращает null;
 * выход за [0, duration] обрезается к границе.
 */
export function skipTarget(
  current: number,
  deltaSec: number,
  duration: number,
  isLive: boolean,
): number | null {
  if (isLive) return null;
  if (!Number.isFinite(current)) return null;
  const target = current + deltaSec;
  const max = Number.isFinite(duration) && duration > 0 ? duration : current;
  return Math.min(Math.max(target, 0), max);
}

/** Перемотать видео на ±сек (учитывает live-режим). */
export function seekBy(video: HTMLVideoElement, deltaSec: number): void {
  const live = !Number.isFinite(video.duration) || video.duration === 0;
  const target = skipTarget(video.currentTime, deltaSec, video.duration, live);
  if (target !== null) video.currentTime = target;
}
