#!/usr/bin/env python3
"""
JARVIS Background Voice Service
================================
Lifecycle:
  startup -> local wake-word detection -> "JARVIS" detected ->
  "Yes, Sir?" -> command capture -> send to JARVIS API ->
  speak reply -> resume wake-word monitoring

Wake-word detection: openwakeword (local, no cloud)
STT after wake: SpeechRecognition + Google Web Speech API
TTS: pyttsx3 (SAPI5 on Windows, fully local)

Controls via stdin:
  pause   - suspend wake-word monitoring
  resume  - restart wake-word monitoring
  mute    - disable TTS
  unmute  - enable TTS
  stop    - clean shutdown

Status is reported to JARVIS API via POST /api/voice/heartbeat every 5s.
"""

import sys
import os
import time
import json
import logging
import threading
import queue
import signal
import subprocess
import struct
import wave
import io
import re

# ── Logging ─────────────────────────────────────────────────────────────────
LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")
os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler(os.path.join(LOG_DIR, "jarvis-voice.log"), encoding="utf-8"),
    ],
)
log = logging.getLogger("jarvis-voice")

# ── Config ────────────────────────────────────────────────────────────────────
API_BASE = "http://127.0.0.1:3000"
HEARTBEAT_INTERVAL = 5          # seconds between heartbeats
COMMAND_TIMEOUT = 8             # seconds to listen for command after wake
SAMPLE_RATE = 16000
CHUNK_SIZE = 1280               # 80ms @ 16kHz — openwakeword requirement
WAKE_THRESHOLD = 0.5            # detection confidence threshold
MAX_RETRIES = 3
SAPI_VOICE_KEYWORDS = ["david", "zira", "mark"]  # preferred SAPI5 voice keywords

# ── State ─────────────────────────────────────────────────────────────────────

class JarvisState:
    def __init__(self):
        self.running = True
        self.paused = False
        self.muted = False
        self.wake_word_active = False
        self.listening = False
        self.lock = threading.Lock()

    def to_dict(self):
        return {
            "status": "listening" if self.wake_word_active else "idle",
            "wakeWordActive": self.wake_word_active,
            "listening": self.listening,
            "muted": self.muted,
            "paused": self.paused,
        }


state = JarvisState()

# ── TTS ───────────────────────────────────────────────────────────────────────

_tts_engine = None
_tts_lock = threading.Lock()


def _init_tts():
    global _tts_engine
    try:
        import pyttsx3
        engine = pyttsx3.init()

        # Select the best available voice (prefer male, David-like voices).
        voices = engine.getProperty("voices")
        selected = None

        # Prefer an English male voice.
        for keyword in SAPI_VOICE_KEYWORDS:
            for voice in voices:
                if keyword.lower() in voice.name.lower():
                    selected = voice
                    break
            if selected:
                break

        # Fall back to any English voice.
        if not selected:
            for voice in voices:
                if "en" in voice.id.lower() or "english" in voice.name.lower():
                    selected = voice
                    break

        if selected:
            engine.setProperty("voice", selected.id)
            log.info(f"TTS voice: {selected.name}")
        else:
            log.warning("No preferred TTS voice found — using system default.")

        engine.setProperty("rate", 185)   # natural reading speed
        engine.setProperty("volume", 1.0)

        _tts_engine = engine
        log.info("TTS engine ready.")
    except Exception as exc:
        log.error(f"TTS init failed: {exc}")
        _tts_engine = None


def speak(text: str):
    """Speak text via pyttsx3, skipping if muted or engine unavailable."""
    if state.muted:
        log.info(f"[MUTED] Would say: {text}")
        return

    # Strip markdown formatting so it doesn't get read aloud.
    clean = re.sub(r"[*_`#~]", "", text)
    clean = re.sub(r"\n+", ". ", clean).strip()

    with _tts_lock:
        if _tts_engine is None:
            log.warning("TTS engine not available — cannot speak.")
            return
        try:
            _tts_engine.say(clean)
            _tts_engine.runAndWait()
        except Exception as exc:
            log.error(f"TTS error: {exc}")


# ── JARVIS API ────────────────────────────────────────────────────────────────

def send_to_jarvis_agent(command: str) -> str:
    """Send a command to the JARVIS agent endpoint and return the reply."""
    try:
        import requests
        resp = requests.post(
            f"{API_BASE}/api/agent",
            json={"message": command},
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        return data.get("reply", "I have completed the task, Sir.")
    except Exception as exc:
        log.error(f"API agent call failed: {exc}")
        return "I encountered an issue communicating with my backend, Sir."


def send_to_jarvis_chat(message: str, history: list = None) -> str:
    """Send a conversational message and return the reply."""
    try:
        import requests
        resp = requests.post(
            f"{API_BASE}/api/chat",
            json={"message": message, "history": history or []},
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json().get("reply", "I didn't catch that, Sir.")
    except Exception as exc:
        log.error(f"API chat call failed: {exc}")
        return "I cannot reach my backend right now, Sir."


def post_heartbeat():
    """Register voice service status with the backend."""
    try:
        import requests
        requests.post(
            f"{API_BASE}/api/voice/heartbeat",
            json=state.to_dict(),
            timeout=3,
        )
    except Exception:
        pass  # Heartbeat failure is non-critical.


# ── STT (Command Capture) ─────────────────────────────────────────────────────

def capture_command() -> str | None:
    """
    Listen for a spoken command using SpeechRecognition.
    Sends audio to Google Web Speech API (cloud) ONLY when called
    — i.e. only after the wake word is confirmed locally.
    Returns the transcript or None.
    """
    try:
        import speech_recognition as sr
    except ImportError:
        log.error("SpeechRecognition not installed.")
        return None

    recognizer = sr.Recognizer()
    recognizer.energy_threshold = 300
    recognizer.dynamic_energy_threshold = True
    recognizer.pause_threshold = 0.8

    try:
        with sr.Microphone(sample_rate=SAMPLE_RATE) as source:
            recognizer.adjust_for_ambient_noise(source, duration=0.5)
            log.info("Listening for command...")

            with state.lock:
                state.listening = True

            audio = recognizer.listen(source, timeout=COMMAND_TIMEOUT, phrase_time_limit=15)

        with state.lock:
            state.listening = False

        try:
            text = recognizer.recognize_google(audio, language="en-IN")
            log.info(f"Command captured: {text}")
            return text
        except sr.UnknownValueError:
            log.info("Command not understood.")
            return None
        except sr.RequestError as exc:
            log.error(f"Google STT error: {exc}")
            return None

    except Exception as exc:
        with state.lock:
            state.listening = False
        log.error(f"Microphone error during command capture: {exc}")
        return None


# ── Wake Word Detection ────────────────────────────────────────────────────────

def _detect_wake_word_openwakeword():
    """
    Detect 'hey jarvis' locally using openwakeword.
    Returns True when a wake word is detected.
    This runs a tight audio capture loop — no audio leaves the device
    during wake-word monitoring.
    """
    try:
        import openwakeword
        from openwakeword.model import Model
        import pyaudio

        # Download bundled models if not present.
        openwakeword.utils.download_models()

        # Use the bundled 'hey_jarvis' model if available, else 'jarvis'.
        model = Model(
            wakeword_models=["hey_jarvis"],
            inference_framework="onnx",
        )

    except Exception as exc:
        log.warning(f"openwakeword unavailable ({exc}), falling back to Google STT keyword detection.")
        return _detect_wake_word_fallback()

    try:
        import pyaudio
        pa = pyaudio.PyAudio()
        stream = pa.open(
            rate=SAMPLE_RATE,
            channels=1,
            format=pyaudio.paInt16,
            input=True,
            frames_per_buffer=CHUNK_SIZE,
        )
    except Exception as exc:
        log.error(f"Could not open microphone for wake detection: {exc}")
        return False

    log.info("Wake-word monitoring active (local openwakeword).")

    try:
        with state.lock:
            state.wake_word_active = True

        while state.running and not state.paused:
            try:
                audio_chunk = stream.read(CHUNK_SIZE, exception_on_overflow=False)
                # openwakeword expects int16 numpy array.
                import numpy as np
                audio_array = np.frombuffer(audio_chunk, dtype=np.int16)

                prediction = model.predict(audio_array)

                # Check any wake-word score.
                for ww_name, score in prediction.items():
                    if score >= WAKE_THRESHOLD:
                        log.info(f"Wake word '{ww_name}' detected (score={score:.2f}).")
                        return True

            except Exception as chunk_exc:
                log.warning(f"Audio chunk error: {chunk_exc}")
                time.sleep(0.1)

    finally:
        with state.lock:
            state.wake_word_active = False
        try:
            stream.stop_stream()
            stream.close()
            pa.terminate()
        except Exception:
            pass

    return False


def _detect_wake_word_fallback():
    """
    Fallback: listen in short segments and check transcript for 'jarvis'.
    Audio is sent to Google only when speech energy is detected.
    This is cloud-based STT, but only for speech segments — not continuous streaming.
    """
    try:
        import speech_recognition as sr
    except ImportError:
        log.error("SpeechRecognition not installed.")
        return False

    recognizer = sr.Recognizer()
    recognizer.energy_threshold = 400
    recognizer.dynamic_energy_threshold = True
    recognizer.pause_threshold = 0.6

    log.info("Wake-word monitoring active (fallback keyword detection).")

    with state.lock:
        state.wake_word_active = True

    try:
        while state.running and not state.paused:
            try:
                with sr.Microphone(sample_rate=SAMPLE_RATE) as source:
                    try:
                        audio = recognizer.listen(
                            source,
                            timeout=3,
                            phrase_time_limit=4,
                        )
                    except sr.WaitTimeoutError:
                        continue

                try:
                    text = recognizer.recognize_google(audio, language="en-IN").lower()
                    log.debug(f"Heard: {text}")

                    if re.search(r"\b(?:hey\s+)?jarvis\b", text):
                        log.info(f"Wake word detected in: '{text}'")
                        return True

                except sr.UnknownValueError:
                    pass
                except sr.RequestError as exc:
                    log.warning(f"STT request failed: {exc}")
                    time.sleep(2)

            except Exception as exc:
                log.error(f"Wake detection loop error: {exc}")
                time.sleep(1)

    finally:
        with state.lock:
            state.wake_word_active = False

    return False


def detect_wake_word() -> bool:
    """Try openwakeword first; fall back to Google STT keyword detection."""
    return _detect_wake_word_openwakeword()


# ── Main Loop ─────────────────────────────────────────────────────────────────

_conversation_history = []


def process_command(command: str):
    """Determine whether to route to agent or chat and speak the reply."""
    log.info(f"Processing: {command}")

    # Keywords that suggest an action should be taken.
    action_keywords = re.compile(
        r"\b(open|launch|start|run|close|lock|shutdown|shut down|restart|reboot|"
        r"show|check|find|search|git|github|commit|push|pull|create|make|write|"
        r"read|list|cancel|stop|what time|time is|system|folder|file|code|fix|"
        r"build|test|memory|remember|forget)\b",
        re.IGNORECASE,
    )

    if action_keywords.search(command):
        # Route to the agent endpoint for task execution.
        reply = send_to_jarvis_agent(command)
    else:
        # Pure conversation.
        reply = send_to_jarvis_chat(command, _conversation_history[-6:])
        _conversation_history.append({"role": "you", "text": command})
        _conversation_history.append({"role": "jarvis", "text": reply})

    log.info(f"Reply: {reply[:120]}...")
    speak(reply)


def main_loop():
    """The primary voice service loop."""
    log.info("=" * 60)
    log.info("JARVIS Voice Service starting.")
    log.info("=" * 60)

    _init_tts()

    # Announce readiness.
    speak("JARVIS voice service is online, Sir. Say 'Hey JARVIS' to get my attention.")

    retry_count = 0

    while state.running:
        if state.paused:
            time.sleep(0.5)
            continue

        # ── Wait for wake word ──────────────────────────────────────────────
        detected = False

        try:
            detected = detect_wake_word()
        except Exception as exc:
            log.error(f"Wake detection error: {exc}")
            retry_count += 1

            if retry_count >= MAX_RETRIES:
                log.error("Too many consecutive wake detection failures. Pausing 30 seconds.")
                time.sleep(30)
                retry_count = 0
            else:
                time.sleep(2)

            continue

        retry_count = 0

        if not detected or not state.running or state.paused:
            continue

        # ── Wake word confirmed ─────────────────────────────────────────────
        log.info("Wake word confirmed. Acknowledging.")
        speak("Yes, Sir?")

        with state.lock:
            state.listening = True

        # ── Capture command ─────────────────────────────────────────────────
        command = None
        try:
            command = capture_command()
        except Exception as exc:
            log.error(f"Command capture error: {exc}")

        with state.lock:
            state.listening = False

        if not command:
            speak("I didn't catch that, Sir. Say 'Hey JARVIS' to try again.")
            continue

        # ── Process command ─────────────────────────────────────────────────
        try:
            process_command(command)
        except Exception as exc:
            log.error(f"Command processing error: {exc}")
            speak("I encountered an error processing that request, Sir.")

    log.info("JARVIS Voice Service stopped.")
    speak("Signing off, Sir. Goodbye.")


# ── Heartbeat Thread ──────────────────────────────────────────────────────────

def heartbeat_thread():
    while state.running:
        post_heartbeat()
        time.sleep(HEARTBEAT_INTERVAL)


# ── Control Thread (stdin) ────────────────────────────────────────────────────

def control_thread():
    """Read control commands from stdin for management scripts."""
    for line in sys.stdin:
        cmd = line.strip().lower()
        log.info(f"Control command: {cmd}")

        if cmd == "pause":
            state.paused = True
            log.info("Voice service paused.")
        elif cmd == "resume":
            state.paused = False
            log.info("Voice service resumed.")
        elif cmd == "mute":
            state.muted = True
            log.info("TTS muted.")
        elif cmd == "unmute":
            state.muted = False
            log.info("TTS unmuted.")
        elif cmd == "stop":
            state.running = False
            break
        elif cmd == "status":
            print(json.dumps(state.to_dict()), flush=True)


# ── Shutdown Handling ─────────────────────────────────────────────────────────

def handle_signal(sig, frame):
    log.info(f"Received signal {sig}. Shutting down.")
    state.running = False


signal.signal(signal.SIGINT, handle_signal)
signal.signal(signal.SIGTERM, handle_signal)

# ── Entry Point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Start heartbeat and control threads.
    threading.Thread(target=heartbeat_thread, daemon=True, name="heartbeat").start()
    threading.Thread(target=control_thread, daemon=True, name="control").start()

    try:
        main_loop()
    except KeyboardInterrupt:
        state.running = False
        log.info("Keyboard interrupt received.")
    except Exception as exc:
        log.critical(f"Fatal error in main loop: {exc}", exc_info=True)
    finally:
        log.info("Voice service exiting.")
