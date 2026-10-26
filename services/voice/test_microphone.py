import sys
import os
import argparse
import time

def main():
    parser = argparse.ArgumentParser(description="JARVIS Safe Microphone Tester")
    parser.add_argument("--list", action="store_true", help="List all available audio input devices")
    parser.add_argument("--device-index", type=int, default=-1, help="Device index to record from")
    parser.add_argument("--device-name", type=str, default="", help="Keyword to search device by name")
    parser.add_argument("--duration", type=int, default=4, help="Duration in seconds to record")
    parser.add_argument("--playback", action="store_true", help="Play back recorded audio sample through speakers")
    parser.add_argument("--save-wav", type=str, default="", help="Optional filepath to save audio WAV")
    parser.add_argument("--lang", type=str, default="en-IN", help="Primary STT language code")
    args = parser.parse_args()

    import pyaudio
    import numpy as np

    p = pyaudio.PyAudio()

    # Device enumeration
    input_devices = []
    print("\nAvailable Audio Input Devices:")
    print("-" * 70)
    for i in range(p.get_device_count()):
        try:
            info = p.get_device_info_by_index(i)
        except Exception:
            continue
        if info.get("maxInputChannels", 0) > 0:
            name = info.get("name", "")
            host_api = info.get("hostApi", 0)
            rate = info.get("defaultSampleRate", 0)
            channels = info.get("maxInputChannels", 0)
            is_rockerz = "rockerz" in name.lower()
            tag = "  --> [ROCKERZ]" if is_rockerz else ""
            print(f"  [{i:2d}] {name:<42} (Ch: {channels}, Rate: {int(rate)}Hz, HostApi: {host_api}){tag}")
            input_devices.append((i, name, info))
    print("-" * 70)

    if args.list:
        p.terminate()
        return

    # Resolve selected device
    target_index = None
    target_info = None

    if args.device_index >= 0:
        for idx, name, info in input_devices:
            if idx == args.device_index:
                target_index = idx
                target_info = info
                break
        if target_index is None:
            print(f"[ERROR] Specified device index {args.device_index} is not a valid input device.")
            p.terminate()
            sys.exit(1)
    elif args.device_name:
        for idx, name, info in input_devices:
            if args.device_name.lower() in name.lower():
                # Prefer hostApi == 0
                if info.get("hostApi") == 0 or target_index is None:
                    target_index = idx
                    target_info = info
    else:
        # Default preference: Rockerz
        for idx, name, info in input_devices:
            if "rockerz" in name.lower():
                if info.get("hostApi") == 0:
                    target_index = idx
                    target_info = info
                    break
                elif target_index is None:
                    target_index = idx
                    target_info = info

    # Fallback to index 2 or default
    if target_index is None:
        for idx, name, info in input_devices:
            if idx == 2:
                target_index = idx
                target_info = info
                break

    if target_index is None:
        try:
            def_info = p.get_default_input_device_info()
            target_index = def_info.get("index")
            target_info = def_info
        except Exception:
            if input_devices:
                target_index = input_devices[0][0]
                target_info = input_devices[0][2]

    if target_index is None:
        print("[ERROR] No audio input device found.")
        p.terminate()
        sys.exit(1)

    print(f"\n[Selected Microphone] Index {target_index}: '{target_info['name']}'")
    print(f"  Channels: {target_info['maxInputChannels']}, Native Rate: {target_info['defaultSampleRate']}Hz")

    # Record sample
    rate = 16000
    chunk = 1024
    channels = 1
    duration = max(1, min(args.duration, 30))

    print(f"\n[Recording] Capturing {duration} seconds from microphone... Speak now!")
    frames = []

    try:
        stream = p.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=rate,
            input=True,
            input_device_index=target_index,
            frames_per_buffer=chunk
        )
    except Exception as exc:
        print(f"[ERROR] Could not open audio input stream: {exc}")
        p.terminate()
        sys.exit(1)

    total_chunks = int(rate / chunk * duration)
    for i in range(total_chunks):
        data = stream.read(chunk, exception_on_overflow=False)
        frames.append(data)

    stream.stop_stream()
    stream.close()
    print("[Recording Complete]")

    raw_audio = b"".join(frames)
    audio_array = np.frombuffer(raw_audio, dtype=np.int16)

    # Volume calculations
    if len(audio_array) > 0:
        rms = int(np.sqrt(np.mean(np.square(audio_array.astype(np.float32)))))
        peak = int(np.max(np.abs(audio_array)))
    else:
        rms, peak = 0, 0

    print("\nAudio Signal Analysis:")
    print(f"  Duration:    {duration:.1f} seconds")
    print(f"  Total Bytes: {len(raw_audio)} bytes ({len(audio_array)} samples @ {rate}Hz)")
    print(f"  RMS Volume:  {rms}")
    print(f"  Peak Volume: {peak} (out of 32767)")

    # Signal assessment
    if peak >= 5000:
        assessment = "EXCELLENT / STRONG SIGNAL"
        color = "PASS"
    elif peak >= 1500:
        assessment = "GOOD / AUDIBLE SIGNAL"
        color = "PASS"
    elif peak >= 500:
        assessment = "LOW / FAINT SIGNAL (Speak closer to headset mic or raise input volume)"
        color = "WARN"
    else:
        assessment = "VERY FAINT OR SILENT (Microphone muted or no audio detected)"
        color = "FAIL"

    print(f"  Signal Assessment: [{color}] {assessment}")

    # Optional WAV saving
    if args.save_wav:
        try:
            import wave
            with wave.open(args.save_wav, "wb") as wf:
                wf.setnchannels(channels)
                wf.setsampwidth(p.get_sample_size(pyaudio.paInt16))
                wf.setframerate(rate)
                wf.writeframes(raw_audio)
            print(f"  Audio saved to: {args.save_wav}")
        except Exception as wav_err:
            print(f"  [ERROR saving WAV]: {wav_err}")

    # Optional Playback
    if args.playback:
        print("\n[Playback] Playing captured audio through speakers...")
        try:
            out_stream = p.open(
                format=pyaudio.paInt16,
                channels=channels,
                rate=rate,
                output=True,
                frames_per_buffer=chunk
            )
            for f in frames:
                out_stream.write(f)
            out_stream.stop_stream()
            out_stream.close()
            print("[Playback Complete]")
        except Exception as play_err:
            print(f"  [Playback error]: {play_err}")

    p.terminate()

    # Speech Recognition Test with AGC Normalization
    print("\nSpeech Recognition Test:")
    print("  Testing Google Speech Recognition against captured audio...")
    try:
        import speech_recognition as sr
        rec = sr.Recognizer()

        # Apply AGC boost if peak is weak (e.g. built-in mic)
        stt_bytes = raw_audio
        if peak > 40 and peak < 14000:
            gain = min(6.0, 15000.0 / max(peak, 1))
            boosted = np.clip(audio_array.astype(np.float32) * gain, -32768, 32767).astype(np.int16)
            stt_bytes = boosted.tobytes()
            print(f"  [AGC Boost] Applied {gain:.2f}x software gain (Peak {peak} -> {np.max(np.abs(boosted))})")

        audio_data = sr.AudioData(stt_bytes, rate, 2)

        transcription_success = False
        for lang in [args.lang, "en-US"]:
            try:
                transcript = rec.recognize_google(audio_data, language=lang)
                if transcript:
                    print(f"  --> Transcribed ({lang}): \"{transcript}\"")
                    transcription_success = True
                    break
            except sr.UnknownValueError:
                print(f"  --> Recognition ({lang}): Unintelligible (no words recognized)")
            except sr.RequestError as req_err:
                print(f"  --> Recognition ({lang}): API Request Error ({req_err})")

        if not transcription_success:
            print("  Note: If speech was spoken, consider speaking more clearly or checking microphone positioning.")
    except Exception as sr_err:
        print(f"  [STT Test Error]: {sr_err}")

    print("\n" + "=" * 70)
    print("Test complete. No computer actions were executed.")
    print("=" * 70)

if __name__ == "__main__":
    main()
