
import { useEffect, useRef, useState } from "react";
import "./App.css";

type Message = {
  role: "jarvis" | "you";
  text: string;
};

type SpeechRecognitionResultEvent = Event & {
  results: {
    [index: number]: {
      [index: number]: {
        transcript: string;
      };
      isFinal: boolean;
    };
  };
};

type SpeechRecognitionErrorEvent = Event & {
  error: string;
};

type SpeechRecognitionInstance = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult:
  | ((event: SpeechRecognitionResultEvent) => void)
  | null;
  onerror:
  | ((event: SpeechRecognitionErrorEvent) => void)
  | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

type BrowserWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

function App() {
  const [backendOnline, setBackendOnline] = useState(false);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [voiceError, setVoiceError] = useState("");
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const [awaitingCommand, setAwaitingCommand] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const wakeRecognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const wakeWordEnabledRef = useRef(false);
  const awaitingCommandRef = useRef(false);
  const suppressWakeRestartRef = useRef(false);
  const processingWakeCommandRef = useRef(false);
  const sendingRef = useRef(false);
  const voiceEnabledRef = useRef(true);
  const messagesRef = useRef<Message[]>([]);

  const [messages, setMessages] = useState<Message[]>([
    {
      role: "jarvis",
      text: "Hello. I'm JARVIS. My AI brain is ready when you are.",
    },
  ]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    sendingRef.current = sending;
  }, [sending]);

  useEffect(() => {
    voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled]);

  useEffect(() => {
    const checkBackend = async () => {
      try {
        const response = await fetch(
          "http://127.0.0.1:3000/api/health"
        );
        setBackendOnline(response.ok);
      } catch {
        setBackendOnline(false);
      }
    };

    void checkBackend();
    const timer = window.setInterval(checkBackend, 10000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      wakeWordEnabledRef.current = false;
      recognitionRef.current?.abort();
      wakeRecognitionRef.current?.abort();
      window.speechSynthesis?.cancel();
    };
  }, []);

  function getRecognitionConstructor() {
    const browserWindow = window as BrowserWindow;

    return (
      browserWindow.SpeechRecognition ||
      browserWindow.webkitSpeechRecognition
    );
  }

  function speakResponse(text: string, onDone?: () => void) {
    if (!voiceEnabledRef.current || !("speechSynthesis" in window)) {
      setSpeaking(false);
      onDone?.();
      return;
    }

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-IN";
    utterance.rate = 1;
    utterance.pitch = 1;

    utterance.onstart = () => setSpeaking(true);

    utterance.onend = () => {
      setSpeaking(false);
      onDone?.();
    };

    utterance.onerror = () => {
      setSpeaking(false);
      onDone?.();
    };

    window.speechSynthesis.speak(utterance);
  }

  async function sendText(
    text: string,
    resumeWakeAfterReply = false
  ) {
    const cleanText = text.trim();

    if (!cleanText || sendingRef.current) {
      if (resumeWakeAfterReply) {
        processingWakeCommandRef.current = false;
        startWakeWordMonitoring();
      }
      return;
    }

    setVoiceError("");
    sendingRef.current = true;
    setSending(true);

    const previousMessages = messagesRef.current;

    const userMessage: Message = {
      role: "you",
      text: cleanText,
    };

    const updatedMessages = [...previousMessages, userMessage];

    messagesRef.current = updatedMessages;
    setMessages(updatedMessages);
    setInput("");

    let reply = "";

    try {
      const response = await fetch(
        "http://127.0.0.1:3000/api/chat",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: cleanText,
            history: previousMessages.map((item) => ({
              role: item.role,
              text: item.text,
            })),
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "The AI request failed.");
      }

      reply = data.reply || "I received an empty response.";
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unable to connect to JARVIS.";

      reply = `Sorry, I couldn't respond. ${errorMessage}`;
    }

    const jarvisMessage: Message = {
      role: "jarvis",
      text: reply,
    };

    const finalMessages = [...messagesRef.current, jarvisMessage];

    messagesRef.current = finalMessages;
    setMessages(finalMessages);

    sendingRef.current = false;
    setSending(false);

    if (resumeWakeAfterReply && wakeWordEnabledRef.current) {
      processingWakeCommandRef.current = false;

      speakResponse(reply, () => {
        if (wakeWordEnabledRef.current) {
          startWakeWordMonitoring();
        }
      });
    } else {
      speakResponse(reply);
    }
  }

  async function sendMessage(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();
    await sendText(input);
  }

  // Existing manual click-to-talk functionality.
  function startListening() {
    setVoiceError("");

    const Recognition = getRecognitionConstructor();

    if (!Recognition) {
      setVoiceError(
        "Voice input is not supported. Please try Google Chrome."
      );
      return;
    }

    if (sendingRef.current) {
      setVoiceError("Please wait for JARVIS to finish responding.");
      return;
    }

    if (wakeWordEnabledRef.current) {
      setVoiceError(
        "Disable Hey JARVIS monitoring before using manual listening."
      );
      return;
    }

    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }

    window.speechSynthesis?.cancel();
    setSpeaking(false);

    try {
      const recognition = new Recognition();

      recognition.lang = "en-IN";
      recognition.continuous = false;
      recognition.interimResults = false;

      recognition.onresult = (event) => {
        const transcript = Array.from(event.results)
          .map((result) => result[0]?.transcript ?? "")
          .join(" ")
          .trim();

        if (transcript) {
          setInput(transcript);
          void sendText(transcript);
        }
      };

      recognition.onerror = (event) => {
        if (event.error === "not-allowed") {
          setVoiceError(
            "Microphone access was denied. Allow microphone access in Chrome."
          );
        } else if (event.error === "no-speech") {
          setVoiceError("I didn't hear anything. Please try again.");
        } else if (event.error !== "aborted") {
          setVoiceError(`Voice input error: ${event.error}.`);
        }

        setListening(false);
      };

      recognition.onend = () => {
        setListening(false);
        recognitionRef.current = null;
      };

      recognitionRef.current = recognition;
      recognition.start();
      setListening(true);
    } catch {
      setListening(false);
      setVoiceError("Unable to start the microphone. Please try again.");
    }
  }

  // Listen for "Hey JARVIS" or "JARVIS".
  function startWakeWordMonitoring() {
    if (!wakeWordEnabledRef.current) return;
    if (sendingRef.current || processingWakeCommandRef.current) return;
    if (wakeRecognitionRef.current) return;

    const Recognition = getRecognitionConstructor();

    if (!Recognition) {
      setVoiceError(
        "Wake-word recognition is not supported in this browser. Try Google Chrome."
      );
      wakeWordEnabledRef.current = false;
      setWakeWordEnabled(false);
      return;
    }

    try {
      const recognition = new Recognition();

      recognition.lang = "en-IN";
      recognition.continuous = false;
      recognition.interimResults = false;

      recognition.onresult = (event) => {
        const transcript = Array.from(event.results)
          .map((result) => result[0]?.transcript ?? "")
          .join(" ")
          .trim();

        if (!transcript) return;

        const wakeMatch = transcript.match(
          /\b(?:hey\s+)?jarvis\b[\s,.:;!?-]*(.*)/i
        );

        if (!wakeMatch) return;

        // Stop this recognition session before handling the command.
        suppressWakeRestartRef.current = true;
        wakeRecognitionRef.current = null;
        recognition.abort();

        const command = (wakeMatch[1] || "").trim();

        if (command) {
          // Supports commands such as "Hey JARVIS, open my project"
          // in a single utterance.
          processingWakeCommandRef.current = true;
          setInput(command);
          void sendText(command, true);
        } else {
          // Wake word only: acknowledge, then listen for the command.
          awaitingCommandRef.current = true;
          setAwaitingCommand(true);

          speakResponse("Yes? I'm listening.", () => {
            if (wakeWordEnabledRef.current) {
              startCommandAfterWakeWord();
            }
          });
        }
      };

      recognition.onerror = (event) => {
        wakeRecognitionRef.current = null;

        if (event.error === "not-allowed") {
          setVoiceError(
            "Microphone access was denied. Allow microphone access in Chrome."
          );
          wakeWordEnabledRef.current = false;
          setWakeWordEnabled(false);
        } else if (
          event.error !== "aborted" &&
          event.error !== "no-speech"
        ) {
          setVoiceError(`Wake-word error: ${event.error}.`);
        }
      };

      recognition.onend = () => {
        wakeRecognitionRef.current = null;

        if (suppressWakeRestartRef.current) {
          suppressWakeRestartRef.current = false;
          return;
        }

        if (
          wakeWordEnabledRef.current &&
          !awaitingCommandRef.current &&
          !processingWakeCommandRef.current
        ) {
          window.setTimeout(startWakeWordMonitoring, 400);
        }
      };

      wakeRecognitionRef.current = recognition;
      recognition.start();
      setVoiceError("");
    } catch {
      wakeRecognitionRef.current = null;

      if (wakeWordEnabledRef.current) {
        setVoiceError(
          "Could not start wake-word monitoring. Check microphone permission and try again."
        );
      }
    }
  }

  // Once JARVIS acknowledges the wake word, capture the actual command.
  function startCommandAfterWakeWord() {
    if (!wakeWordEnabledRef.current) return;

    const Recognition = getRecognitionConstructor();

    if (!Recognition) {
      setVoiceError("Speech recognition is unavailable.");
      stopWakeWordMonitoring();
      return;
    }

    try {
      const recognition = new Recognition();

      recognition.lang = "en-IN";
      recognition.continuous = false;
      recognition.interimResults = false;

      wakeRecognitionRef.current = recognition;

      recognition.onresult = (event) => {
        const command = Array.from(event.results)
          .map((result) => result[0]?.transcript ?? "")
          .join(" ")
          .trim();

        if (!command) return;

        processingWakeCommandRef.current = true;
        awaitingCommandRef.current = false;
        setAwaitingCommand(false);
        setInput(command);

        void sendText(command, true);
      };

      recognition.onerror = (event) => {
        if (event.error === "not-allowed") {
          setVoiceError("Please allow microphone access in Chrome.");
        } else if (event.error === "no-speech") {
          setVoiceError("I didn't hear a command. Say Hey JARVIS to try again.");
        } else if (event.error !== "aborted") {
          setVoiceError(`Command recognition error: ${event.error}.`);
        }
      };

      recognition.onend = () => {
        wakeRecognitionRef.current = null;

        if (awaitingCommandRef.current) {
          awaitingCommandRef.current = false;
          setAwaitingCommand(false);

          if (
            wakeWordEnabledRef.current &&
            !processingWakeCommandRef.current
          ) {
            window.setTimeout(startWakeWordMonitoring, 500);
          }
        }
      };

      recognition.start();
    } catch {
      wakeRecognitionRef.current = null;
      awaitingCommandRef.current = false;
      setAwaitingCommand(false);
      setVoiceError("Unable to capture your command. Try again.");
      startWakeWordMonitoring();
    }
  }

  function enableWakeWord() {
    setVoiceError("");

    if (sendingRef.current) {
      setVoiceError("Wait until JARVIS finishes responding first.");
      return;
    }

    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
      setListening(false);
    }

    window.speechSynthesis?.cancel();
    setSpeaking(false);

    wakeWordEnabledRef.current = true;
    awaitingCommandRef.current = false;
    processingWakeCommandRef.current = false;

    setWakeWordEnabled(true);
    setAwaitingCommand(false);

    startWakeWordMonitoring();
  }

  function stopWakeWordMonitoring() {
    wakeWordEnabledRef.current = false;
    awaitingCommandRef.current = false;
    processingWakeCommandRef.current = false;

    setWakeWordEnabled(false);
    setAwaitingCommand(false);

    suppressWakeRestartRef.current = true;
    wakeRecognitionRef.current?.abort();
    wakeRecognitionRef.current = null;

    setVoiceError("Hey JARVIS monitoring is disabled.");
  }

  function toggleWakeWord() {
    if (wakeWordEnabledRef.current) {
      stopWakeWordMonitoring();
    } else {
      enableWakeWord();
    }
  }

  function stopSpeaking() {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }

  function toggleVoiceResponses() {
    if (voiceEnabledRef.current) {
      stopSpeaking();
      voiceEnabledRef.current = false;
      setVoiceEnabled(false);
    } else {
      voiceEnabledRef.current = true;
      setVoiceEnabled(true);
      setVoiceError("");
    }
  }

  return (
    <main className="dashboard">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">J</span>
          <div>
            <h1>J.A.R.V.I.S.</h1>
            <p>PERSONAL AI SYSTEM</p>
          </div>
        </div>

        <div className="system-status">
          <span
            className={`status-dot ${backendOnline ? "online" : ""}`}
          />
          {backendOnline ? "BACKEND ONLINE" : "BACKEND OFFLINE"}
        </div>
      </header>

      <section className="hero">
        <p className="eyebrow">PERSONAL INTELLIGENCE INTERFACE</p>
        <h2>At your service.</h2>
        <p className="subtitle">
          Your assistant. Your workspace. Your commands.
        </p>

        <div className="reactor">
          <div className="reactor-ring ring-one" />
          <div className="reactor-ring ring-two" />
          <div className="reactor-core">J</div>
        </div>

        <p className="assistant-state">
          {awaitingCommand
            ? "WAKE WORD DETECTED · WAITING FOR COMMAND"
            : wakeWordEnabled
              ? "HEY JARVIS MONITORING ACTIVE"
              : listening
                ? "LISTENING FOR YOUR COMMAND"
                : speaking
                  ? "JARVIS IS SPEAKING"
                  : sending
                    ? "PROCESSING YOUR REQUEST"
                    : backendOnline
                      ? "SYSTEMS NOMINAL"
                      : "AWAITING CONNECTION"}
        </p>
      </section>

      <section className="workspace">
        <div className="panel-heading">
          <div>
            <h3>Command Center</h3>
            <p>Communicate with your assistant</p>
          </div>
          <span className="terminal-label">SESSION 001</span>
        </div>

        <div className="messages" aria-live="polite">
          {messages.map((message, index) => (
            <div className={`message ${message.role}`} key={index}>
              <span className="message-role">
                {message.role === "jarvis" ? "JARVIS" : "YOU"}
              </span>
              <p>{message.text}</p>
            </div>
          ))}

          {sending && (
            <div className="message jarvis">
              <span className="message-role">JARVIS</span>
              <p>Thinking...</p>
            </div>
          )}
        </div>

        <form className="command-form" onSubmit={sendMessage}>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask JARVIS anything..."
            aria-label="Type a command"
            maxLength={4000}
            disabled={sending}
          />

          <button type="submit" disabled={sending || !input.trim()}>
            {sending ? "Thinking..." : "Send ↗"}
          </button>
        </form>

        <div className="voice-controls">
          <button
            type="button"
            onClick={startListening}
            disabled={sending || wakeWordEnabled}
            aria-pressed={listening}
            className={listening ? "voice-active" : ""}
          >
            {listening ? "⏹ Stop Listening" : "🎙️ Speak to JARVIS"}
          </button>

          <button
            type="button"
            onClick={toggleWakeWord}
            disabled={sending && !wakeWordEnabled}
            aria-pressed={wakeWordEnabled}
            className={wakeWordEnabled ? "voice-active" : ""}
          >
            {wakeWordEnabled
              ? "⏹ Disable Hey JARVIS"
              : "🎤 Enable Hey JARVIS"}
          </button>

          <button
            type="button"
            onClick={toggleVoiceResponses}
            aria-pressed={voiceEnabled}
          >
            {voiceEnabled
              ? "🔊 Voice Responses On"
              : "🔇 Voice Responses Off"}
          </button>

          {speaking && (
            <button type="button" onClick={stopSpeaking}>
              ⏹ Stop Speaking
            </button>
          )}
        </div>

        {wakeWordEnabled && !awaitingCommand && (
          <p className="voice-status" role="status">
            Wake-word monitoring is enabled. Say “Hey JARVIS” clearly.
          </p>
        )}

        {awaitingCommand && (
          <p className="voice-status" role="status">
            JARVIS is listening for your command.
          </p>
        )}

        {listening && (
          <p className="voice-status" role="status">
            Listening... Speak clearly, then pause.
          </p>
        )}

        {speaking && (
          <p className="voice-status" role="status">
            JARVIS is speaking. You can stop the response anytime.
          </p>
        )}

        {voiceError && (
          <p className="voice-error" role="alert">
            {voiceError}
          </p>
        )}

        <p className="notice">
          Voice recognition uses your browser's speech service. Spoken
          responses use your browser's built-in speech synthesis.
          Wake-word monitoring runs only while this page is open.
        </p>
      </section>

      <footer>JARVIS PERSONAL AI · DEVELOPMENT BUILD 0.4</footer>
    </main>
  );
}

export default App;
