import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	CanvasSource,
	AudioBufferSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from "mediabunny";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat, ExportQuality } from "@/types/export";
import { CanvasRenderer } from "./canvas-renderer";

type ExportParams = {
	width: number;
	height: number;
	fps: number;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
};

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

function getSupportedMediaRecorderMimeType({
	format,
}: {
	format: ExportFormat;
}): string | null {
	if (typeof MediaRecorder === "undefined") return null;

	const candidates =
		format === "mp4"
			? [
					"video/mp4;codecs=h264,aac",
					"video/mp4;codecs=avc1.42E01E,mp4a.40.2",
					"video/mp4",
				]
			: [
					"video/webm;codecs=vp9,opus",
					"video/webm;codecs=vp8,opus",
					"video/webm",
				];

	for (const mimeType of candidates) {
		try {
			if (MediaRecorder.isTypeSupported(mimeType)) return mimeType;
		} catch {
			// ignore
		}
	}
	return null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let ffmpegSingleton: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;

async function getFfmpeg(): Promise<FFmpeg> {
	if (ffmpegSingleton) return ffmpegSingleton;
	if (ffmpegLoadPromise) return ffmpegLoadPromise;

	ffmpegLoadPromise = (async () => {
		const ffmpeg = new FFmpeg();
		// Load from Next.js public assets.
		const coreURL = await toBlobURL("/ffmpeg/ffmpeg-core.js", "text/javascript");
		const wasmURL = await toBlobURL("/ffmpeg/ffmpeg-core.wasm", "application/wasm");
		await ffmpeg.load({ coreURL, wasmURL });
		ffmpegSingleton = ffmpeg;
		return ffmpeg;
	})();

	return ffmpegLoadPromise;
}

async function canvasToPngBlob(
	canvas: OffscreenCanvas | HTMLCanvasElement,
): Promise<Blob> {
	if (canvas instanceof OffscreenCanvas) {
		return await canvas.convertToBlob({ type: "image/png" });
	}
	return await new Promise<Blob>((resolve, reject) => {
		canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Failed to create PNG"))), "image/png");
	});
}

function audioBufferToWavBytes(buffer: AudioBuffer): Uint8Array {
	const numChannels = buffer.numberOfChannels;
	const sampleRate = buffer.sampleRate;
	const length = buffer.length;

	const bytesPerSample = 2; // 16-bit PCM
	const blockAlign = numChannels * bytesPerSample;
	const byteRate = sampleRate * blockAlign;
	const dataSize = length * blockAlign;
	const totalSize = 44 + dataSize;

	const arrayBuffer = new ArrayBuffer(totalSize);
	const view = new DataView(arrayBuffer);
	let offset = 0;

	const writeAscii = (s: string) => {
		for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i));
	};

	writeAscii("RIFF");
	view.setUint32(offset, 36 + dataSize, true);
	offset += 4;
	writeAscii("WAVE");
	writeAscii("fmt ");
	view.setUint32(offset, 16, true);
	offset += 4;
	view.setUint16(offset, 1, true); // PCM
	offset += 2;
	view.setUint16(offset, numChannels, true);
	offset += 2;
	view.setUint32(offset, sampleRate, true);
	offset += 4;
	view.setUint32(offset, byteRate, true);
	offset += 4;
	view.setUint16(offset, blockAlign, true);
	offset += 2;
	view.setUint16(offset, 16, true); // bits per sample
	offset += 2;
	writeAscii("data");
	view.setUint32(offset, dataSize, true);
	offset += 4;

	// Interleave channels, convert float [-1,1] to int16.
	const channels = Array.from({ length: numChannels }, (_, ch) =>
		buffer.getChannelData(ch),
	);
	for (let i = 0; i < length; i++) {
		for (let ch = 0; ch < numChannels; ch++) {
			const s = Math.max(-1, Math.min(1, channels[ch][i] ?? 0));
			const int16 = s < 0 ? s * 0x8000 : s * 0x7fff;
			view.setInt16(offset, int16, true);
			offset += 2;
		}
	}

	return new Uint8Array(arrayBuffer);
}

export type SceneExporterEvents = {
	progress: [progress: number];
	complete: [buffer: ArrayBuffer];
	error: [error: Error];
	cancelled: [];
};

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;

	private isCancelled = false;

	constructor({
		width,
		height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
		});

		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;
	}

	cancel(): void {
		this.isCancelled = true;
	}

	async export({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ArrayBuffer | null> {
		// mediabunny relies on WebCodecs for encoding.
		// When unavailable (e.g. some Safari/older browsers), fall back to MediaRecorder.
		if (typeof VideoEncoder === "undefined") {
			return await this.exportViaMediaRecorder({ rootNode });
		}

		const { fps } = this.renderer;
		const frameCount = Math.ceil(rootNode.duration * fps);

		const outputFormat =
			this.format === "webm" ? new WebMOutputFormat() : new Mp4OutputFormat();

		const output = new Output({
			format: outputFormat,
			target: new BufferTarget(),
		});

		const videoSource = new CanvasSource(this.renderer.canvas, {
			codec: this.format === "webm" ? "vp9" : "avc",
			bitrate: qualityMap[this.quality],
		});

		output.addVideoTrack(videoSource, { frameRate: fps });

		let audioSource: AudioBufferSource | null = null;
		if (this.shouldIncludeAudio && this.audioBuffer) {
			let audioCodec: "aac" | "opus" =
				this.format === "webm" ? "opus" : "aac";

			if (audioCodec === "aac" && typeof AudioEncoder !== "undefined") {
				const { supported } = await AudioEncoder.isConfigSupported({
					codec: "mp4a.40.2",
					sampleRate: this.audioBuffer.sampleRate,
					numberOfChannels: this.audioBuffer.numberOfChannels,
					bitrate: 192000,
				});
				if (!supported) audioCodec = "opus";
			}

			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: qualityMap[this.quality],
			});
			output.addAudioTrack(audioSource);
		}

		await output.start();

		if (audioSource && this.audioBuffer) {
			await audioSource.add(this.audioBuffer);
			audioSource.close();
		}

		for (let i = 0; i < frameCount; i++) {
			if (this.isCancelled) {
				await output.cancel();
				this.emit("cancelled");
				return null;
			}

			const time = i / fps;
			await this.renderer.render({ node: rootNode, time });
			await videoSource.add(time, 1 / fps);

			this.emit("progress", i / frameCount);
		}

		if (this.isCancelled) {
			await output.cancel();
			this.emit("cancelled");
			return null;
		}

		videoSource.close();
		await output.finalize();
		this.emit("progress", 1);

		const buffer = output.target.buffer;
		if (!buffer) {
			this.emit("error", new Error("Failed to export video"));
			return null;
		}

		this.emit("complete", buffer);
		return buffer;
	}

	private async exportViaMediaRecorder({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ArrayBuffer | null> {
		const { fps, canvas } = this.renderer;
		const frameCount = Math.ceil(rootNode.duration * fps);

		const mimeType = getSupportedMediaRecorderMimeType({ format: this.format });
		if (!mimeType) {
			throw new Error(
				"Video export is not supported by this browser (missing WebCodecs VideoEncoder and no supported MediaRecorder format).",
			);
		}

		// Some browsers support MediaRecorder but only expose captureStream on HTMLCanvasElement,
		// while our renderer may use OffscreenCanvas. Render into a temporary HTMLCanvasElement.
		const captureCanvas =
			canvas instanceof OffscreenCanvas
				? Object.assign(document.createElement("canvas"), {
						width: canvas.width,
						height: canvas.height,
					})
				: canvas;

		const captureStream =
			(captureCanvas as HTMLCanvasElement).captureStream?.bind(
				captureCanvas as HTMLCanvasElement,
			) ?? null;

		if (!captureStream) {
			// Fall back to ffmpeg.wasm, which does not require captureStream.
			return await this.exportViaFfmpegWasm({ rootNode });
		}

		const videoStream = captureStream(fps);
		let audioCtx: AudioContext | null = null;
		let bufferSource: AudioBufferSourceNode | null = null;
		let audioDestination: MediaStreamAudioDestinationNode | null = null;

		try {
			let stream = videoStream;

			if (this.shouldIncludeAudio && this.audioBuffer) {
				audioCtx = new AudioContext();
				audioDestination = audioCtx.createMediaStreamDestination();
				bufferSource = audioCtx.createBufferSource();
				bufferSource.buffer = this.audioBuffer;
				bufferSource.connect(audioDestination);

				stream = new MediaStream([
					...videoStream.getVideoTracks(),
					...audioDestination.stream.getAudioTracks(),
				]);
			}

			const chunks: BlobPart[] = [];
			const recorder = new MediaRecorder(stream, { mimeType });

			const done = new Promise<Blob>((resolve, reject) => {
				recorder.addEventListener("dataavailable", (event) => {
					if (event.data && event.data.size > 0) chunks.push(event.data);
				});
				recorder.addEventListener("error", () =>
					reject(new Error("MediaRecorder failed during export")),
				);
				recorder.addEventListener("stop", () =>
					resolve(new Blob(chunks, { type: mimeType })),
				);
			});

			// Render first frame before starting to avoid blank lead-in.
			if (captureCanvas !== canvas) {
				await this.renderer.renderToCanvas({
					node: rootNode,
					time: 0,
					targetCanvas: captureCanvas as HTMLCanvasElement,
				});
			} else {
				await this.renderer.render({ node: rootNode, time: 0 });
			}

			if (audioCtx && bufferSource) {
				// Some browsers start AudioContext suspended until user gesture; we try anyway.
				if (audioCtx.state === "suspended") {
					try {
						await audioCtx.resume();
					} catch {
						// ignore
					}
				}
				bufferSource.start(0);
			}

			recorder.start(250);

			const frameDurationMs = 1000 / fps;
			const start = performance.now();

			for (let i = 0; i < frameCount; i++) {
				if (this.isCancelled) {
					try {
						recorder.stop();
					} catch {
						// ignore
					}
					this.emit("cancelled");
					return null;
				}

				const time = i / fps;
				if (captureCanvas !== canvas) {
					await this.renderer.renderToCanvas({
						node: rootNode,
						time,
						targetCanvas: captureCanvas as HTMLCanvasElement,
					});
				} else {
					await this.renderer.render({ node: rootNode, time });
				}

				this.emit("progress", i / frameCount);

				const targetTime = start + (i + 1) * frameDurationMs;
				const wait = targetTime - performance.now();
				if (wait > 0) await sleep(wait);
			}

			this.emit("progress", 1);

			// Give recorder a moment to flush last frames/audio.
			await sleep(200);
			recorder.stop();

			const blob = await done;
			const buffer = await blob.arrayBuffer();
			if (!buffer) {
				this.emit("error", new Error("Failed to export video"));
				return null;
			}

			this.emit("complete", buffer);
			return buffer;
		} finally {
			try {
				videoStream.getTracks().forEach((t) => t.stop());
			} catch {
				// ignore
			}
			try {
				bufferSource?.stop();
			} catch {
				// ignore
			}
			try {
				await audioCtx?.close();
			} catch {
				// ignore
			}
		}
	}

	private async exportViaFfmpegWasm({
		rootNode,
	}: {
		rootNode: RootNode;
	}): Promise<ArrayBuffer | null> {
		const { fps, canvas } = this.renderer;
		const frameCount = Math.ceil(rootNode.duration * fps);
		const ffmpeg = await getFfmpeg();

		const framePattern = "frame_%05d.png";
		const outputName = this.format === "webm" ? "output.webm" : "output.mp4";
		const audioName = "audio.wav";

		try {
			// Write frames.
			for (let i = 0; i < frameCount; i++) {
				if (this.isCancelled) {
					this.emit("cancelled");
					return null;
				}
				const time = i / fps;
				await this.renderer.render({ node: rootNode, time });
				const png = await canvasToPngBlob(canvas);
				const fileName = `frame_${String(i + 1).padStart(5, "0")}.png`;
				await ffmpeg.writeFile(fileName, await fetchFile(png));
				this.emit("progress", i / frameCount);
			}

			const args: string[] = ["-framerate", String(fps), "-i", framePattern];

			// Optional audio.
			if (this.shouldIncludeAudio && this.audioBuffer) {
				const wavBytes = audioBufferToWavBytes(this.audioBuffer);
				await ffmpeg.writeFile(audioName, wavBytes);
				args.push("-i", audioName);
			}

			if (this.format === "webm") {
				args.push(
					"-c:v",
					"libvpx-vp9",
					"-pix_fmt",
					"yuv420p",
					"-b:v",
					String(qualityMap[this.quality]),
				);
				if (this.shouldIncludeAudio && this.audioBuffer) {
					args.push("-c:a", "libopus");
				}
			} else {
				// mp4
				args.push(
					"-c:v",
					"libx264",
					"-pix_fmt",
					"yuv420p",
					"-b:v",
					String(qualityMap[this.quality]),
				);
				if (this.shouldIncludeAudio && this.audioBuffer) {
					args.push("-c:a", "aac");
				}
			}

			args.push("-shortest", "-movflags", "+faststart", outputName);

			await ffmpeg.exec(args);
			this.emit("progress", 1);

			const out = await ffmpeg.readFile(outputName);
			const buffer = (out as Uint8Array).buffer.slice(
				(out as Uint8Array).byteOffset,
				(out as Uint8Array).byteOffset + (out as Uint8Array).byteLength,
			);

			this.emit("complete", buffer);
			return buffer;
		} finally {
			// Best-effort cleanup (ignore failures).
			try {
				await ffmpeg.deleteFile(outputName);
			} catch {
				// ignore
			}
			try {
				await ffmpeg.deleteFile(audioName);
			} catch {
				// ignore
			}
			for (let i = 0; i < frameCount; i++) {
				try {
					const fileName = `frame_${String(i + 1).padStart(5, "0")}.png`;
					await ffmpeg.deleteFile(fileName);
				} catch {
					// ignore
				}
			}
		}
	}
}
