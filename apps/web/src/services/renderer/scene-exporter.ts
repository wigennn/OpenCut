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

		const canvasAny = canvas as unknown as HTMLCanvasElement & {
			captureStream?: (fps?: number) => MediaStream;
		};
		const captureStream = canvasAny.captureStream?.bind(canvasAny);
		if (!captureStream) {
			throw new Error(
				"Video export is not supported by this browser (canvas captureStream is unavailable).",
			);
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
			await this.renderer.render({ node: rootNode, time: 0 });

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
				await this.renderer.render({ node: rootNode, time });

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
}
