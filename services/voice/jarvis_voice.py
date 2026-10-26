#!/usr/bin/env python3
"""
JARVIS Universal Voice Service
==============================
Continuous, automatic wake-word detection and voice assistant service.
Works with ANY microphone: Bluetooth headset (Rockerz 110) or built-in laptop mic array.

Key Capabilities:
  - Universal Microphone Adaptation: automatically detects and selects Rockerz 110
    headset if connected; automatically and smoothly falls back to the built-in
    laptop microphone array if the headset is off or disconnected.
  - Software Automatic Gain Control (AGC): dynamically boosts weak input signals
    (such as distant built-in laptop microphones) so openWakeWord and Google STT
    always receive loud, full-scale acoustic features.
  - Sensitive & Adaptive Speech Recognition: energy threshold adapts to room ambient noise
    with sensitive lower bounds, ensuring quiet speech into built-in mics is never swallowed.
  - Dual-Language STT: Indian English (en-IN) primary with fallback to US English (en-US).
  - Polite Interactive Retry: Speaks "Sorry, Sir, I didn't catch that. Please repeat."
    when speech is unintelligible, without executing empty commands.
  - Echo & Reverb Immunity: wake-word inference is paused while JARVIS speaks, with
    reverb delay and openWakeWord model reset to avoid self-triggering.
  - Seamless Reconnection: automatically re-scans audio devices on stream drop or disconnect.
"""

import sys
import os
import time
import json
import logging
import threading
import signal
import re
import numpy as np

# ── Logging ─────────────────────────────────────────────────────────────────
LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")
os.makedirs(LOG_DIR, exist_ok=True)

log_handlers = [
    logging.FileHandler(os.path.join(LOG_DIR, "jarvis-voice.log"), encoding="utf-8")
]
if sys.stdout is not None and hasattr(sys.stdout, "isatty") and sys.stdout.isatty():
    log_handlers.append(logging.StreamHandler(sys.stdout))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=log_handlers,
)
log = logging.getLogger("jarvis-voice")

def log_uncaught_exception(exc_type, exc_value, exc_traceback):
    if issubclass(exc_type, KeyboardInterrupt):
        sys.__excepthook__(exc_type, exc_value, exc_traceback)
        return
    log.critical("Uncaught exception in voice service:", exc_info=(exc_type, exc_value, exc_traceback))
    try:
        err_file = os.path.join(LOG_DIR, "jarvis-voice-err.log")
        with open(err_file, "a", encoding="utf-8") as f:
            import traceback
            f.write(f"\n--- Uncaught Exception at {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
            traceback.print_exception(exc_type, exc_value, exc_traceback, file=f)
    except Exception:
        pass

sys.excepthook = log_uncaught_exception

# ── Config ────────────────────────────────────────────────────────────────────
API_BASE = "http://127.0.0.1:3000"
HEARTBEAT_INTERVAL = 2          # seconds between heartbeats
COMMAND_TIMEOUT = 8             # seconds to wait for speech after wake
SAMPLE_RATE = 16000
CHUNK_SIZE = 1280               # 80ms @ 16kHz (openwakeword input requirement)
WAKE_THRESHOLD = 0.40           # sensitive detection threshold for 'hey_jarvis'
MAX_RETRIES = 5
SAPI_VOICE_KEYWORDS = ["david", "zira", "mark"]

PREFERRED_MIC_KEYWORDS = ["rockerz", "rockerz 110", "headset"]
BUILTIN_MIC_KEYWORDS = ["microphone array", "smart sound", "realtek", "array", "built-in", "mapper"]
DEFAULT_STT_PRIMARY_LANG = os.environ.get("JARVIS_STT_LANG", "en-IN")
DEFAULT_STT_FALLBACK_LANG = "en-US"

CONTROL_FILE = os.path.join(os.path.dirname(__file__), "control.cmd")
PID_FILE = os.path.join(os.path.dirname(__file__), "jarvis-voice.pid")

# ── Microphone State & Resolution ─────────────────────────────────────────────
_selected_mic_index = None
_selected_mic_name = "Default"
_selected_mic_info = {}
_is_headset = False

def resolve_microphone(pa_instance=None):
    """
    Universally resolve best available microphone:
    1. If Rockerz 110 headset is connected, use it.
    2. If headset is NOT connected, seamlessly fall back to built-in laptop mic array.
    Returns (device_index, device_name, device_info_dict).
    """
    global _selected_mic_index, _selected_mic_name, _selected_mic_info, _is_headset

    close_pa = False
    if pa_instance is None:
        import pyaudio
        pa_instance = pyaudio.PyAudio()
        close_pa = True

    env_device = os.environ.get("JARVIS_MIC_DEVICE", "").strip()
    headset_devices = []
    builtin_devices = []
    all_inputs = []

    try:
        count = pa_instance.get_device_count()
        for i in range(count):
            try:
                info = pa_instance.get_device_info_by_index(i)
            except Exception:
                continue
            if info.get("maxInputChannels", 0) > 0:
                name = info.get("name", "")
                all_inputs.append((i, name, info))

                # Check manual override
                if env_device:
                    if env_device.isdigit() and int(env_device) == i:
                        _selected_mic_index = i
                        _selected_mic_name = name
                        _selected_mic_info = info
                        _is_headset = any(k in name.lower() for k in PREFERRED_MIC_KEYWORDS)
                        log.info(f"Microphone manually configured via env: [{i}] '{name}'")
                        return i, name, info
                    elif env_device.lower() in name.lower():
                        headset_devices.append((i, name, info))
                else:
                    # Categorize into headset vs built-in
                    if any(kw in name.lower() for kw in PREFERRED_MIC_KEYWORDS):
                        headset_devices.append((i, name, info))
                    elif any(kw in name.lower() for kw in BUILTIN_MIC_KEYWORDS):
                        builtin_devices.append((i, name, info))

        # Priority 1: Headset (if present and connected)
        if headset_devices:
            # Prefer MME (hostApi == 0)
            selected = None
            for idx, name, info in headset_devices:
                if info.get("hostApi") == 0:
                    selected = (idx, name, info)
                    break
            if not selected:
                selected = headset_devices[0]

            _selected_mic_index, _selected_mic_name, _selected_mic_info = selected
            _is_headset = True
            log.info(
                f"[MIC SELECTED: HEADSET] [{_selected_mic_index}] '{_selected_mic_name}' "
                f"(HostApi={_selected_mic_info.get('hostApi')}, Ch={_selected_mic_info.get('maxInputChannels')}, "
                f"Rate={_selected_mic_info.get('defaultSampleRate')}Hz)"
            )
            return _selected_mic_index, _selected_mic_name, _selected_mic_info

        # Priority 2: Built-in Microphone Array (when headset is NOT connected)
        if builtin_devices:
            selected = None
            for idx, name, info in builtin_devices:
                if info.get("hostApi") == 0:
                    selected = (idx, name, info)
                    break
            if not selected:
                selected = builtin_devices[0]

            _selected_mic_index, _selected_mic_name, _selected_mic_info = selected
            _is_headset = False
            log.info(
                f"[MIC SELECTED: BUILT-IN] [{_selected_mic_index}] '{_selected_mic_name}' "
                f"(Headset not connected; using built-in laptop mic array with AGC boost)"
            )
            return _selected_mic_index, _selected_mic_name, _selected_mic_info

        # Priority 3: System default input
        try:
            default_info = pa_instance.get_default_input_device_info()
            idx = default_info.get("index")
            name = default_info.get("name", "Default")
            _selected_mic_index = idx
            _selected_mic_name = name
            _selected_mic_info = default_info
            _is_headset = False
            log.info(f"[MIC SELECTED: SYSTEM DEFAULT] [{idx}] '{name}'")
            return idx, name, default_info
        except Exception:
            pass

        if all_inputs:
            idx, name, info = all_inputs[0]
            _selected_mic_index = idx
            _selected_mic_name = name
            _selected_mic_info = info
            _is_headset = False
            log.info(f"[MIC SELECTED: FIRST AVAILABLE] [{idx}] '{name}'")
            return idx, name, info

        raise RuntimeError("No audio input devices found in audio subsystem!")

    finally:
        if close_pa:
            try:
                pa_instance.terminate()
            except Exception:
                pass

# ── Software Automatic Gain Control (AGC) ────────────────────────────────────

def normalize_audio_chunk(audio_array: np.ndarray, target_peak: int = 15000, max_gain: float = 6.0) -> np.ndarray:
    """
    Automatic Gain Control (AGC) for weak microphones (e.g. built-in laptop mic array).
    Dynamically scales audible audio to full acoustic scale so openWakeWord and Google STT
    hear clearly regardless of whether a headset or built-in microphone is in use.
    """
    if len(audio_array) == 0:
        return audio_array
    curr_peak = int(np.max(np.abs(audio_array)))
    # If audio has audible signal (> 40) but is below target, scale it smoothly
    if 40 < curr_peak < target_peak:
        gain = min(max_gain, float(target_peak) / max(curr_peak, 1))
        boosted = np.clip(audio_array.astype(np.float32) * gain, -32768, 32767).astype(np.int16)
        return boosted
    return audio_array

# ── State ─────────────────────────────────────────────────────────────────────

class JarvisState:
    def __init__(self):
        self.running = True
        self.paused = False
        self.muted = False
        self.status = "starting"   # starting | listening | capturing | processing | speaking | paused | error
        self.error = None
        self.wake_word_active = False
        self.listening = False
        self.speaking = False
        self.processing = False
        self.lock = threading.Lock()

    def set_state(self, status: str, error: str = None):
        with self.lock:
            self.status = status
            self.error = error
            self.wake_word_active = (status == "listening")
            self.listening = (status in ("listening", "capturing"))
            self.speaking = (status == "speaking")
            self.processing = (status == "processing")
            if status == "paused":
                self.paused = True
            elif status == "listening" and self.paused:
                self.paused = False

    def to_dict(self):
        with self.lock:
            return {
                "status": self.status,
                "wakeWordActive": self.wake_word_active,
                "listening": self.listening,
                "speaking": self.speaking,
                "processing": self.processing,
                "muted": self.muted,
                "paused": self.paused,
                "error": self.error,
                "micDevice": _selected_mic_name,
                "micIndex": _selected_mic_index,
                "isHeadset": _is_headset,
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

        voices = engine.getProperty("voices")
        selected = None

        # Prefer English male voice (David)
        for keyword in SAPI_VOICE_KEYWORDS:
            for voice in voices:
                if keyword.lower() in voice.name.lower():
                    selected = voice
                    break
            if selected:
                break

        if not selected:
            for voice in voices:
                if "en" in voice.id.lower() or "english" in voice.name.lower():
                    selected = voice
                    break

        if selected:
            engine.setProperty("voice", selected.id)
            log.info(f"TTS voice selected: {selected.name}")
        else:
            log.warning("No preferred voice found; using system default.")

        engine.setProperty("rate", 185)
        engine.setProperty("volume", 1.0)
        _tts_engine = engine
        log.info("TTS engine ready.")
    except Exception as exc:
        log.error(f"TTS initialization failed: {exc}")
        _tts_engine = None

def speak(text: str, update_state: bool = True):
    """Speak text via pyttsx3, ensuring wake-word detection does not hear itself."""
    if state.muted:
        log.info(f"[MUTED] Would say: {text}")
        return

    clean = re.sub(r"[*_`#~]", "", text)
    clean = re.sub(r"\n+", ". ", clean).strip()
    if not clean:
        return

    previous_status = state.status
    if update_state:
        state.set_state("speaking")

    log.info(f"TTS speaking: '{clean[:80]}...'")
    try:
        with _tts_lock:
            if _tts_engine is None:
                log.warning("TTS engine not available.")
                return
            _tts_engine.say(clean)
            _tts_engine.runAndWait()
        log.info("TTS completed.")
    except Exception as exc:
        log.error(f"TTS error during speech: {exc}")
    finally:
        # Reverb delay: wait for room sound to subside so the mic doesn't catch the tail of speech
        time.sleep(0.5)
        if update_state and state.running and not state.paused:
            state.set_state("listening")

# ── Backend Communication ────────────────────────────────────────────────────

def send_to_jarvis_agent(command: str) -> str:
    """Send command to unified JARVIS agent endpoint (the exact same endpoint used by typed commands)."""
    try:
        import requests
        resp = requests.post(
            f"{API_BASE}/api/agent",
            json={"message": command},
            timeout=60,
        )
        if resp.status_code == 200:
            data = resp.json()
            return data.get("reply", "Task completed, Sir.")
        else:
            log.warning(f"Agent returned HTTP {resp.status_code}: {resp.text}")
            return "I understood your command, but the backend reported an issue processing it, Sir."
    except Exception as exc:
        log.error(f"API agent call failed: {exc}")
        return "I cannot reach my backend right now, Sir. Please ensure the backend server is running."

def post_heartbeat():
    """Send heartbeat to backend and process any pending control command."""
    try:
        import requests
        resp = requests.post(
            f"{API_BASE}/api/voice/heartbeat",
            json=state.to_dict(),
            timeout=2,
        )
        if resp.ok:
            data = resp.json()
            cmd = data.get("command")
            if cmd:
                execute_control_command(cmd)
    except Exception:
        pass

def execute_control_command(cmd: str):
    """Execute a control command."""
    cmd = cmd.strip().lower()
    log.info(f"Executing control command: '{cmd}'")
    if cmd == "pause":
        with state.lock:
            state.paused = True
            state.status = "paused"
            state.wake_word_active = False
            state.listening = False
        log.info("Voice service paused.")
    elif cmd == "resume":
        with state.lock:
            state.paused = False
            state.status = "listening"
            state.wake_word_active = True
            state.listening = True
        log.info("Voice service resumed.")
    elif cmd == "mute":
        with state.lock:
            state.muted = True
        log.info("TTS muted.")
    elif cmd == "unmute":
        with state.lock:
            state.muted = False
        log.info("TTS unmuted.")
    elif cmd == "stop":
        with state.lock:
            state.running = False
        log.info("Stop requested via control command.")

def check_control_file():
    """Check if control.cmd was written by a management script."""
    if os.path.exists(CONTROL_FILE):
        try:
            with open(CONTROL_FILE, "r", encoding="utf-8") as f:
                cmd = f.read().strip()
            os.remove(CONTROL_FILE)
            if cmd:
                execute_control_command(cmd)
        except Exception as exc:
            log.warning(f"Error reading control file: {exc}")

# ── Wake Word & Audio ─────────────────────────────────────────────────────────

_wake_model = None
_recognizer = None

def _init_wake_model():
    global _wake_model
    try:
        from openwakeword.model import Model
        _wake_model = Model(
            wakeword_models=["hey_jarvis"],
            inference_framework="onnx",
        )
        log.info("Local openwakeword model initialized successfully (trained phrase: 'Hey JARVIS').")
        return True
    except Exception as exc:
        log.warning(f"openwakeword model init failed ({exc}). Fallback to STT keyword matching.")
        _wake_model = None
        return False

def _init_audio():
    """Initialize SpeechRecognition recognizer, select microphone, and calibrate ambient noise once."""
    global _recognizer, _selected_mic_index, _selected_mic_name
    try:
        import speech_recognition as sr

        if _selected_mic_index is None:
            resolve_microphone()

        rec = sr.Recognizer()
        rec.energy_threshold = 200
        rec.dynamic_energy_threshold = True
        rec.dynamic_energy_adjustment_damping = 0.15
        rec.dynamic_energy_ratio = 1.5
        rec.pause_threshold = 0.8
        rec.phrase_threshold = 0.3
        rec.non_speaking_duration = 0.5

        # Calibrate once at startup with ambient noise using resolved device
        try:
            with sr.Microphone(device_index=_selected_mic_index, sample_rate=SAMPLE_RATE) as source:
                log.info(f"Calibrating microphone [{_selected_mic_index}] '{_selected_mic_name}' for ambient noise (0.8s)...")
                rec.adjust_for_ambient_noise(source, duration=0.8)
                # Keep energy threshold sensitive so quiet speech into built-in mics is not ignored
                rec.energy_threshold = max(60.0, min(rec.energy_threshold, 600.0))
                log.info(f"Microphone calibrated. Energy threshold: {rec.energy_threshold:.1f}")
        except Exception as e:
            log.warning(f"Ambient noise calibration skipped ({e}). Using default threshold 150.")
            rec.energy_threshold = 150.0

        _recognizer = rec
        return True
    except Exception as exc:
        log.error(f"Failed to initialize audio recognizer: {exc}")
        return False

def capture_command() -> tuple[str | None, str]:
    """
    Capture user command using SpeechRecognition with software AGC boost.
    Returns: (transcript, status)
      status in ('success', 'no_speech', 'unintelligible', 'api_error', 'device_error')
    """
    global _recognizer, _selected_mic_index, _selected_mic_name
    try:
        import speech_recognition as sr
    except ImportError:
        log.error("speech_recognition package missing.")
        return None, "device_error"

    if _recognizer is None:
        _init_audio()
    if _recognizer is None:
        return None, "device_error"

    if _selected_mic_index is None:
        resolve_microphone()

    try:
        state.set_state("capturing")
        log.info(f"Listening for command on device [{_selected_mic_index}] '{_selected_mic_name}'...")
        with sr.Microphone(device_index=_selected_mic_index, sample_rate=SAMPLE_RATE) as source:
            try:
                audio = _recognizer.listen(source, timeout=COMMAND_TIMEOUT, phrase_time_limit=15)
            except sr.WaitTimeoutError:
                log.info("Listening timed out waiting for speech to begin (no speech detected).")
                return None, "no_speech"

        # Measure captured audio volume & apply AGC boost
        raw_bytes = audio.get_raw_data()
        duration = len(raw_bytes) / (audio.sample_rate * audio.sample_width)
        arr = np.frombuffer(raw_bytes, dtype=np.int16)
        if len(arr) > 0:
            rms = int(np.sqrt(np.mean(np.square(arr.astype(np.float32)))))
            peak = int(np.max(np.abs(arr)))
            # Apply AGC boost to command audio so Google STT receives full-gain signal
            boosted_arr = normalize_audio_chunk(arr, target_peak=15000, max_gain=6.0)
            audio = sr.AudioData(boosted_arr.tobytes(), audio.sample_rate, audio.sample_width)
        else:
            rms, peak = 0, 0

        log.info(f"Command audio captured: duration={duration:.2f}s, Raw RMS={rms}, Raw Peak={peak}")

        state.set_state("processing")

        # Dual-language recognition: try primary (en-IN), fallback to secondary (en-US)
        languages_to_try = [DEFAULT_STT_PRIMARY_LANG]
        if DEFAULT_STT_FALLBACK_LANG not in languages_to_try:
            languages_to_try.append(DEFAULT_STT_FALLBACK_LANG)

        for lang in languages_to_try:
            try:
                text = _recognizer.recognize_google(audio, language=lang)
                if text and text.strip():
                    text = text.strip()
                    log.info(f"Command transcribed successfully ({lang}): '{text}'")
                    return text, "success"
            except sr.UnknownValueError:
                log.info(f"Speech unintelligible under language '{lang}'.")
            except sr.RequestError as exc:
                log.error(f"Google STT service request error ({lang}): {exc}")
                return None, "api_error"

        # If both language attempts failed with UnknownValueError
        log.info(f"Speech was captured (RMS={rms}, Peak={peak}) but could not be understood.")
        return None, "unintelligible"

    except Exception as exc:
        log.error(f"Microphone error during command capture: {exc}")
        return None, "device_error"

def detect_wake_word_openwakeword() -> bool:
    """Continuously stream microphone audio into openwakeword with AGC normalization."""
    global _selected_mic_index, _selected_mic_name
    if _wake_model is None:
        return detect_wake_word_fallback()

    try:
        import pyaudio
        pa = pyaudio.PyAudio()
        if _selected_mic_index is None:
            resolve_microphone(pa)

        stream = pa.open(
            rate=SAMPLE_RATE,
            channels=1,
            format=pyaudio.paInt16,
            input=True,
            input_device_index=_selected_mic_index,
            frames_per_buffer=CHUNK_SIZE,
        )
    except Exception as exc:
        log.error(f"Could not open microphone [{_selected_mic_index}] for wake detection: {exc}")
        # Try re-resolving microphone in case device was disconnected
        try:
            resolve_microphone()
        except Exception:
            pass
        state.set_state("error", str(exc))
        return False

    state.set_state("listening")
    log.info(f"JARVIS is listening for wake word ('Hey JARVIS') on device [{_selected_mic_index}] '{_selected_mic_name}'.")
    if _wake_model:
        _wake_model.reset()

    try:
        frame_count = 0
        max_recent_score = 0.0

        while state.running and not state.paused:
            check_control_file()
            if state.paused or not state.running:
                break

            try:
                audio_chunk = stream.read(CHUNK_SIZE, exception_on_overflow=False)
                raw_array = np.frombuffer(audio_chunk, dtype=np.int16)

                frame_count += 1
                rms = int(np.sqrt(np.mean(np.square(raw_array.astype(np.float32)))))
                peak = int(np.max(np.abs(raw_array)))

                # Apply AGC to frame chunk so built-in mic speech triggers wake-word effortlessly
                audio_array = normalize_audio_chunk(raw_array, target_peak=14000, max_gain=6.0)

                prediction = _wake_model.predict(audio_array)

                for ww_name, score in prediction.items():
                    if score > max_recent_score:
                        max_recent_score = score

                    # Periodic log every ~4 seconds (50 chunks @ 80ms)
                    if frame_count % 50 == 0:
                        log.info(
                            f"[Audio Status] Monitoring: dev='{_selected_mic_name}' (idx={_selected_mic_index}), "
                            f"RMS={rms}, Peak={peak}, max_score={max_recent_score:.4f}"
                        )
                        max_recent_score = 0.0

                    if score >= 0.15 and score < WAKE_THRESHOLD:
                        log.info(f"Wake-word candidate detected: '{ww_name}' score={score:.3f} (threshold={WAKE_THRESHOLD})")

                    if score >= WAKE_THRESHOLD:
                        log.info(
                            f"Wake word '{ww_name}' DETECTED! score={score:.3f} >= {WAKE_THRESHOLD} "
                            f"(RMS={rms}, Peak={peak})"
                        )
                        if _wake_model:
                            _wake_model.reset()
                        return True

            except Exception as chunk_exc:
                log.warning(f"Audio read error on [{_selected_mic_index}]: {chunk_exc}")
                time.sleep(0.1)
                break  # Exit to re-open stream and re-resolve device

    finally:
        try:
            stream.stop_stream()
            stream.close()
            pa.terminate()
        except Exception:
            pass

    return False

def detect_wake_word_fallback() -> bool:
    """Fallback STT-based keyword detector if openwakeword is unavailable."""
    global _selected_mic_index, _selected_mic_name
    try:
        import speech_recognition as sr
    except ImportError:
        log.error("SpeechRecognition not installed.")
        state.set_state("error", "SpeechRecognition not installed.")
        return False

    if _selected_mic_index is None:
        resolve_microphone()

    recognizer = sr.Recognizer()
    recognizer.energy_threshold = 200
    recognizer.dynamic_energy_threshold = True
    recognizer.pause_threshold = 0.6

    state.set_state("listening")
    log.info(f"Wake-word monitoring active (fallback mode) on [{_selected_mic_index}] '{_selected_mic_name}'.")

    while state.running and not state.paused:
        check_control_file()
        if state.paused or not state.running:
            break

        try:
            with sr.Microphone(device_index=_selected_mic_index, sample_rate=SAMPLE_RATE) as source:
                try:
                    audio = recognizer.listen(source, timeout=3, phrase_time_limit=4)
                except sr.WaitTimeoutError:
                    continue

            try:
                text = recognizer.recognize_google(audio, language="en-IN").lower()
                if re.search(r"\b(?:hey\s+)?jarvis\b", text):
                    log.info(f"Wake word detected in: '{text}'")
                    return True
            except (sr.UnknownValueError, sr.RequestError):
                pass

        except Exception as exc:
            log.error(f"Fallback wake detection error: {exc}")
            state.set_state("error", str(exc))
            time.sleep(1)

    return False

# ── Main Service Loop ────────────────────────────────────────────────────────

def normalize_spoken_command(raw_text: str) -> str:
    """Normalize spoken text: safely strip wake phrases and conversational filler while preserving intent."""
    if not raw_text:
        return ""
    text = raw_text.strip()
    text = re.sub(r"^(?:(?:hey|ok|hi|hello)\s+)?jarvis[,:\s]*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^(?:please\s+|could\s+you\s+(?:please\s+)?|can\s+you\s+(?:please\s+)?|would\s+you\s+(?:please\s+)?|kindly\s+)", "", text, flags=re.IGNORECASE)
    text = re.sub(r"[.?!]+$", "", text).strip()
    text = re.sub(r"\s+", " ", text)
    return text

def process_command(raw_command: str):
    """Route command to unified agent (exact same brain and registry as typed commands) and speak the reply."""
    state.set_state("processing")
    cleaned = normalize_spoken_command(raw_command)
    if not cleaned:
        cleaned = raw_command.strip()
    log.info(f"Processing command: raw='{raw_command}' -> normalized='{cleaned}'")

    reply = send_to_jarvis_agent(cleaned)
    log.info(f"Agent reply: {reply[:100]}...")

    state.set_state("speaking")
    speak(reply)

def main_loop():
    """Main lifecycle loop for JARVIS background voice assistant."""
    log.info("=" * 60)
    log.info("JARVIS Universal Voice Service starting.")
    log.info("=" * 60)

    state.set_state("starting")
    _init_tts()
    _init_wake_model()
    _init_audio()

    dev_label = "Headset" if _is_headset else "Built-in Microphone"
    speak(f"JARVIS voice service is online, Sir. Listening via {dev_label}.")

    retries = 0

    while state.running:
        check_control_file()

        if state.paused:
            state.set_state("paused")
            time.sleep(0.5)
            continue

        detected = False
        try:
            detected = detect_wake_word_openwakeword()
        except Exception as exc:
            log.error(f"Wake detection error: {exc}")
            state.set_state("error", str(exc))
            retries += 1
            if retries >= MAX_RETRIES:
                log.error("Multiple wake detection failures; re-resolving microphone device.")
                try:
                    resolve_microphone()
                except Exception:
                    pass
                time.sleep(5)
                retries = 0
            else:
                time.sleep(1)
            continue

        retries = 0

        if not detected or not state.running or state.paused:
            continue

        # ── Step 1: Acknowledge wake word aloud ─────────────────────────────
        log.info("Wake word confirmed. Acknowledging with 'Yes, Sir?'")
        state.set_state("speaking")
        speak("Yes, Sir?")

        # ── Step 2: Capture command ─────────────────────────────────────────
        command, status = capture_command()

        if status == "no_speech":
            log.info("No speech heard after wake word.")
            state.set_state("speaking")
            speak("I didn't hear a command, Sir. Say 'Hey JARVIS' when you're ready.")
            if _wake_model:
                _wake_model.reset()
            state.set_state("listening")
            continue

        elif status == "unintelligible":
            log.info("Speech was unintelligible. Speaking retry prompt.")
            state.set_state("speaking")
            speak("Sorry, Sir, I didn't catch that. Please repeat.")
            if _wake_model:
                _wake_model.reset()
            state.set_state("listening")
            continue

        elif status == "api_error":
            log.warning("Speech recognition service error.")
            state.set_state("speaking")
            speak("I am having trouble reaching the speech recognition service right now, Sir.")
            if _wake_model:
                _wake_model.reset()
            state.set_state("listening")
            continue

        elif not command or status != "success":
            log.info(f"Command capture incomplete (status={status}).")
            if _wake_model:
                _wake_model.reset()
            state.set_state("listening")
            continue

        # ── Step 3: Process command and speak response ──────────────────────
        try:
            process_command(command)
        except Exception as exc:
            log.error(f"Command processing error: {exc}")
            state.set_state("speaking")
            speak("I encountered an error processing that request, Sir.")

        # ── Step 4: Resume wake-word monitoring ─────────────────────────────
        log.info("Command cycle complete. Resuming wake-word monitoring.")
        if _wake_model:
            _wake_model.reset()
        state.set_state("listening")

    log.info("JARVIS Voice Service stopping.")
    speak("Signing off, Sir. Goodbye.")

# ── Threads & Signals ────────────────────────────────────────────────────────

def heartbeat_worker():
    while state.running:
        post_heartbeat()
        time.sleep(HEARTBEAT_INTERVAL)

def handle_signal(sig, frame):
    log.info(f"Signal {sig} received. Stopping voice service.")
    state.running = False

signal.signal(signal.SIGINT, handle_signal)
signal.signal(signal.SIGTERM, handle_signal)

# ── Entry Point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    try:
        with open(PID_FILE, "w", encoding="ascii") as f:
            f.write(str(os.getpid()))
    except Exception as e:
        log.warning(f"Could not write PID file: {e}")

    threading.Thread(target=heartbeat_worker, daemon=True, name="heartbeat").start()

    try:
        main_loop()
    except KeyboardInterrupt:
        state.running = False
        log.info("Keyboard interrupt received.")
    except Exception as exc:
        log.critical(f"Fatal error in voice main loop: {exc}", exc_info=True)
    finally:
        try:
            if os.path.exists(PID_FILE):
                os.remove(PID_FILE)
        except Exception:
            pass
        log.info("JARVIS Voice Service terminated.")
