import {
	Input,
	ALL_FORMATS,
	BlobSource,
	CanvasSink,
	type WrappedCanvas,
} from "mediabunny";

interface VideoSinkData {
	mode: "mediabunny" | "html-video";

	// mediabunny mode
	sink: CanvasSink | null;
	iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null;
	currentFrame: WrappedCanvas | null;
	nextFrame: WrappedCanvas | null;
	lastTime: number;
	prefetching: boolean;
	prefetchPromise: Promise<void> | null;

	// html-video fallback mode
	videoEl: HTMLVideoElement | null;
	videoObjectUrl: string | null;
	canvas: OffscreenCanvas | HTMLCanvasElement | null;
}

export class VideoCache {
	private sinks = new Map<string, VideoSinkData>();
	private initPromises = new Map<string, Promise<void>>();

	async getFrameAt({
		mediaId,
		file,
		time,
	}: {
		mediaId: string;
		file: File;
		time: number;
	}): Promise<WrappedCanvas | null> {
		await this.ensureSink({ mediaId, file });

		const sinkData = this.sinks.get(mediaId);
		if (!sinkData) return null;

		if (sinkData.mode === "html-video") {
			return await this.getHtmlVideoFrameAt({ sinkData, time });
		}

		if (sinkData.nextFrame && sinkData.nextFrame.timestamp <= time) {
			sinkData.currentFrame = sinkData.nextFrame;
			sinkData.nextFrame = null;
			this.startPrefetch({ sinkData });
		}

		if (
			sinkData.currentFrame &&
			this.isFrameValid({ frame: sinkData.currentFrame, time })
		) {
			if (!sinkData.nextFrame && !sinkData.prefetching) {
				this.startPrefetch({ sinkData });
			}
			return sinkData.currentFrame;
		}

		if (
			sinkData.iterator &&
			sinkData.currentFrame &&
			time >= sinkData.lastTime &&
			time < sinkData.lastTime + 2.0
		) {
			const frame = await this.iterateToTime({ sinkData, targetTime: time });
			if (frame) {
				if (!sinkData.nextFrame && !sinkData.prefetching) {
					this.startPrefetch({ sinkData });
				}
				return frame;
			}
		}

		const frame = await this.seekToTime({ sinkData, time });
		if (frame && !sinkData.nextFrame && !sinkData.prefetching) {
			this.startPrefetch({ sinkData });
		}
		return frame;
	}

	private isFrameValid({
		frame,
		time,
	}: {
		frame: WrappedCanvas;
		time: number;
	}): boolean {
		return time >= frame.timestamp && time < frame.timestamp + frame.duration;
	}
	private async iterateToTime({
		sinkData,
		targetTime,
	}: {
		sinkData: VideoSinkData;
		targetTime: number;
	}): Promise<WrappedCanvas | null> {
		if (sinkData.mode !== "mediabunny") return null;
		if (!sinkData.iterator) return null;

		try {
			while (true) {
				// Wait for any pending prefetch to finish before touching iterator
				if (sinkData.prefetching && sinkData.prefetchPromise) {
					await sinkData.prefetchPromise;
				}

				// Check if the nextFrame (which might have just arrived) is what we need
				if (
					sinkData.nextFrame &&
					sinkData.nextFrame.timestamp <= targetTime + 0.05 // Tolerance
				) {
					sinkData.currentFrame = sinkData.nextFrame;
					sinkData.nextFrame = null;
				} else {
					const { value: frame, done } = await sinkData.iterator.next();

					if (done || !frame) break;

					sinkData.currentFrame = frame;
				}

				const frame = sinkData.currentFrame;
				if (!frame) break;

				sinkData.lastTime = frame.timestamp;

				if (this.isFrameValid({ frame, time: targetTime })) {
					return frame;
				}

				if (frame.timestamp > targetTime + 1.0) break;
			}
		} catch (error) {
			console.warn("Iterator failed, will restart:", error);
			sinkData.iterator = null;
		}

		return null;
	}
	private async seekToTime({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		if (sinkData.mode !== "mediabunny") return null;
		try {
			if (sinkData.prefetching && sinkData.prefetchPromise) {
				await sinkData.prefetchPromise;
			}

			if (sinkData.iterator) {
				await sinkData.iterator.return();
				sinkData.iterator = null;
			}

			sinkData.nextFrame = null;
			if (!sinkData.sink) return null;
			sinkData.iterator = sinkData.sink.canvases(time);
			sinkData.lastTime = time;

			// Fetch current frame
			const { value: frame } = await sinkData.iterator.next();

			if (frame) {
				sinkData.currentFrame = frame;

				// Aggressively fetch next frame immediately to fill buffer
				// This matches the mediaplayer example which fetches 2 frames on start
				try {
					const { value: next } = await sinkData.iterator.next();
					if (next) {
						sinkData.nextFrame = next;
					}
				} catch (e) {
					console.warn("Failed to pre-fetch next frame on seek:", e);
				}

				return frame;
			}
		} catch (error) {
			console.warn("Failed to seek video:", error);
		}

		return null;
	}

	private startPrefetch({ sinkData }: { sinkData: VideoSinkData }): void {
		if (
			sinkData.mode !== "mediabunny" ||
			sinkData.prefetching ||
			!sinkData.iterator ||
			sinkData.nextFrame
		) {
			return;
		}

		sinkData.prefetching = true;
		sinkData.prefetchPromise = this.prefetchNextFrame({ sinkData });
	}

	private async prefetchNextFrame({
		sinkData,
	}: {
		sinkData: VideoSinkData;
	}): Promise<void> {
		if (sinkData.mode !== "mediabunny") return;
		if (!sinkData.iterator) {
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			return;
		}

		try {
			const { value: frame, done } = await sinkData.iterator.next();

			if (done || !frame) {
				sinkData.prefetching = false;
				sinkData.prefetchPromise = null;
				return;
			}

			sinkData.nextFrame = frame;
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
		} catch (error) {
			console.warn("Prefetch failed:", error);
			sinkData.prefetching = false;
			sinkData.prefetchPromise = null;
			sinkData.iterator = null;
		}
	}
	private async ensureSink({
		mediaId,
		file,
	}: {
		mediaId: string;
		file: File;
	}): Promise<void> {
		if (this.sinks.has(mediaId)) return;

		if (this.initPromises.has(mediaId)) {
			await this.initPromises.get(mediaId);
			return;
		}

		const initPromise = this.initializeSink({ mediaId, file });
		this.initPromises.set(mediaId, initPromise);

		try {
			await initPromise;
		} finally {
			this.initPromises.delete(mediaId);
		}
	}
	private async initializeSink({
		mediaId,
		file,
	}: {
		mediaId: string;
		file: File;
	}): Promise<void> {
		try {
			const input = new Input({
				source: new BlobSource(file),
				formats: ALL_FORMATS,
			});

			const videoTrack = await input.getPrimaryVideoTrack();
			if (!videoTrack) {
				throw new Error("No video track found");
			}

			const canDecode = await videoTrack.canDecode();
			if (!canDecode) {
				throw new Error("Video codec not supported for decoding");
			}

			const sink = new CanvasSink(videoTrack, {
				poolSize: 3,
				fit: "contain",
			});

			this.sinks.set(mediaId, {
				mode: "mediabunny",
				sink,
				iterator: null,
				currentFrame: null,
				nextFrame: null,
				lastTime: -1,
				prefetching: false,
				prefetchPromise: null,
				videoEl: null,
				videoObjectUrl: null,
				canvas: null,
			});
		} catch (error) {
			console.warn(
				`Mediabunny decode unavailable for ${mediaId}, falling back to <video>:`,
				error,
			);
			await this.initializeHtmlVideoFallback({ mediaId, file });
		}
	}

	private async initializeHtmlVideoFallback({
		mediaId,
		file,
	}: {
		mediaId: string;
		file: File;
	}): Promise<void> {
		const videoEl = document.createElement("video");
		videoEl.muted = true;
		videoEl.playsInline = true;
		videoEl.preload = "auto";

		const objectUrl = URL.createObjectURL(file);
		videoEl.src = objectUrl;

		await new Promise<void>((resolve, reject) => {
			const onLoaded = () => {
				cleanup();
				resolve();
			};
			const onError = () => {
				cleanup();
				reject(new Error("Video metadata load failed"));
			};
			const cleanup = () => {
				videoEl.removeEventListener("loadedmetadata", onLoaded);
				videoEl.removeEventListener("error", onError);
			};

			videoEl.addEventListener("loadedmetadata", onLoaded, { once: true });
			videoEl.addEventListener("error", onError, { once: true });
			videoEl.load();
		});

		const width = Math.max(1, videoEl.videoWidth || 1);
		const height = Math.max(1, videoEl.videoHeight || 1);
		const canvas =
			typeof OffscreenCanvas !== "undefined"
				? new OffscreenCanvas(width, height)
				: Object.assign(document.createElement("canvas"), { width, height });

		this.sinks.set(mediaId, {
			mode: "html-video",
			sink: null,
			iterator: null,
			currentFrame: null,
			nextFrame: null,
			lastTime: -1,
			prefetching: false,
			prefetchPromise: null,
			videoEl,
			videoObjectUrl: objectUrl,
			canvas,
		});
	}

	private async getHtmlVideoFrameAt({
		sinkData,
		time,
	}: {
		sinkData: VideoSinkData;
		time: number;
	}): Promise<WrappedCanvas | null> {
		if (sinkData.mode !== "html-video") return null;
		if (!sinkData.videoEl || !sinkData.canvas) return null;

		const video = sinkData.videoEl;
		const canvas = sinkData.canvas;

		const target = Math.max(0, time);
		const needsSeek = !Number.isFinite(video.currentTime)
			? true
			: Math.abs(video.currentTime - target) > 0.05;

		if (needsSeek) {
			try {
				await this.seekHtmlVideo({ video, time: target });
			} catch (e) {
				console.warn("HTML video seek failed:", e);
				return null;
			}
		}

		const ctx =
			canvas instanceof OffscreenCanvas
				? canvas.getContext("2d")
				: canvas.getContext("2d");
		if (!ctx) return null;

		try {
			ctx.drawImage(video, 0, 0, (canvas as any).width, (canvas as any).height);
		} catch (e) {
			console.warn("HTML video drawImage failed:", e);
			return null;
		}

		const durationGuess = Number.isFinite(video.duration) && video.duration > 0
			? Math.min(1 / 24, Math.max(1 / 60, 1 / 30))
			: 1 / 30;

		return {
			canvas: canvas as any,
			timestamp: target,
			duration: durationGuess,
			close: () => {},
		} as unknown as WrappedCanvas;
	}

	private async seekHtmlVideo({
		video,
		time,
	}: {
		video: HTMLVideoElement;
		time: number;
	}): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			let timeoutId: number | null = null;

			const cleanup = () => {
				video.removeEventListener("seeked", onSeeked);
				video.removeEventListener("error", onError);
				if (timeoutId !== null) window.clearTimeout(timeoutId);
			};
			const onSeeked = () => {
				cleanup();
				resolve();
			};
			const onError = () => {
				cleanup();
				reject(new Error("Video seek error"));
			};

			video.addEventListener("seeked", onSeeked, { once: true });
			video.addEventListener("error", onError, { once: true });
			timeoutId = window.setTimeout(() => {
				cleanup();
				reject(new Error("Video seek timeout"));
			}, 4000);

			video.currentTime = time;
		});
	}

	clearVideo({ mediaId }: { mediaId: string }): void {
		const sinkData = this.sinks.get(mediaId);
		if (sinkData) {
			if (sinkData.iterator) {
				void sinkData.iterator.return();
			}
			if (sinkData.videoEl) {
				try {
					sinkData.videoEl.pause();
				} catch {
					// ignore
				}
				sinkData.videoEl.removeAttribute("src");
				sinkData.videoEl.load();
				sinkData.videoEl.remove();
			}
			if (sinkData.videoObjectUrl) {
				URL.revokeObjectURL(sinkData.videoObjectUrl);
			}

			this.sinks.delete(mediaId);
		}

		this.initPromises.delete(mediaId);
	}

	clearAll(): void {
		for (const [mediaId] of this.sinks) {
			this.clearVideo({ mediaId });
		}
	}

	getStats() {
		return {
			totalSinks: this.sinks.size,
			activeSinks: Array.from(this.sinks.values()).filter((s) => s.iterator)
				.length,
			cachedFrames: Array.from(this.sinks.values()).filter(
				(s) => s.currentFrame,
			).length,
		};
	}
}

export const videoCache = new VideoCache();
