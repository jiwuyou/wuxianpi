"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantTtsConfig, TtsClientInstruction } from "@/lib/wuxianpi/contracts";
import { speakText } from "@/components/wuxianpi/api";

function cleanForSpeech(text: string, readCode: boolean): string {
  let next = text;
  if (!readCode) next = next.replace(/```[\s\S]*?```/g, "（代码块已省略）");
  return next
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[>*_~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function speakInBrowser(instruction: TtsClientInstruction): Promise<void> {
  if (!("speechSynthesis" in window)) return Promise.reject(new Error("当前浏览器不支持语音朗读"));
  window.speechSynthesis.cancel();
  return new Promise((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(instruction.text);
    utterance.rate = instruction.rate ?? 1;
    utterance.pitch = instruction.pitch ?? 1;
    if (instruction.voice) {
      const voice = window.speechSynthesis.getVoices().find((item) => item.name === instruction.voice || item.voiceURI === instruction.voice);
      if (voice) utterance.voice = voice;
    }
    utterance.onend = () => resolve();
    utterance.onerror = (event) => reject(new Error(event.error || "语音朗读失败"));
    window.speechSynthesis.speak(utterance);
  });
}

export function useTts(assistantId?: string, config?: AssistantTtsConfig | "inherit") {
  const resolved = config === "inherit" ? undefined : config;
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const runRef = useRef(0);

  const stop = useCallback(() => {
    runRef.current += 1;
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    audioRef.current?.pause();
    audioRef.current = null;
    setSpeaking(false);
  }, []);

  const speak = useCallback(async (rawText: string, preview = false) => {
    const text = cleanForSpeech(rawText, resolved?.readCode ?? false);
    if (!text) return;
    stop();
    const run = runRef.current;
    setSpeaking(true);
    setError(null);
    try {
      let output: TtsClientInstruction | Blob | null;
      try {
        output = await speakText({
          profileId: resolved?.profileId ?? "browser-default",
          assistantId,
          text,
          rate: resolved?.rate,
          pitch: resolved?.pitch,
          readCode: resolved?.readCode,
          preview,
        });
      } catch {
        output = { kind: "browser-speech", text, rate: resolved?.rate, pitch: resolved?.pitch };
      }
      if (runRef.current !== run) return;
      if (output === null) {
        return;
      }
      if (output instanceof Blob) {
        const url = URL.createObjectURL(output);
        const audio = new Audio(url);
        audioRef.current = audio;
        await new Promise<void>((resolvePromise, reject) => {
          audio.onended = () => resolvePromise();
          audio.onerror = () => reject(new Error("音频播放失败"));
          void audio.play().catch(reject);
        });
        URL.revokeObjectURL(url);
      } else {
        await speakInBrowser(output);
      }
    } catch (reason) {
      if (runRef.current === run) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (runRef.current === run) setSpeaking(false);
    }
  }, [assistantId, resolved?.pitch, resolved?.profileId, resolved?.rate, resolved?.readCode, stop]);

  useEffect(() => stop, [stop]);

  return { speak, stop, speaking, error };
}
