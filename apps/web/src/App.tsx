import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";

// ─── Types ──────────────────────────────────────────────────────────────────

type Message = { role: "jarvis" | "you"; text: string; timestamp: string };

type Memory = { id: number; content: string; category: string; created_at: string };

type ApprovalRequest = { id: string; prompt: string; plan: unknown; createdAt: string };

type VoiceStatus = {
  online: boolean;
  status: string; // 'starting' | 'listening' | 'capturing' | 'processing' | 'speaking' | 'paused' | 'error' | 'offline'
  wakeWordActive: boolean;
  listening: boolean;
  speaking?: boolean;
  processing?: boolean;
  muted: boolean;
  paused?: boolean;
  error?: string | null;
};

type SystemInfo = {
  time: string;
  date: string;
  uptime: string;
  platform: string;
  release: string;
  freeRamGB: string;
  totalRamGB: string;
  cpus: number;
  cpuModel: string;
  hostname: string;
};

type GitStatus = {
  success: boolean;
  branch?: string;
  status?: string;
  recentCommits?: string[];
  message?: string;
};

type BackendHealth = {
  provider?: string;
  providers?: { ollama: { available: boolean }; gemini: { available: boolean } };
  memory?: string;
  version?: string;
};

type SpeechRecognitionResultEvent = Event & {
  results: { [i: number]: { [i: number]: { transcript: string }; isFinal: boolean } };
};
type SpeechRecognitionErrorEvent = Event & { error: string };
type SpeechRecognitionInstance = {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((e: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;
type BrowserWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

type Tab = "chat" | "agent" | "memories" | "approvals" | "status" | "settings";

// ─── Helpers ────────────────────────────────────────────────────────────────

const API = "http://127.0.0.1:3000";
const ts = () => new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });

// ─── App ────────────────────────────────────────────────────────────────────

export default function App() {
  // Navigation
  const [tab, setTab] = useState<Tab>("chat");

  // Backend
  const [backendOnline, setBackendOnline] = useState(false);
  const [health, setHealth] = useState<BackendHealth>({});
  const [provider, setProvider] = useState("ollama");

  // Chat
  const [messages, setMessages] = useState<Message[]>([{
    role: "jarvis", text: "Good day, Sir. JARVIS is online and ready.", timestamp: ts(),
  }]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  // Agent mode toggle
  const [agentMode, setAgentMode] = useState(false);

  // Browser speech (manual mic & browser TTS fallback)
  const [manualListening, setManualListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [browserVoiceEnabled, setBrowserVoiceEnabled] = useState(true);
  const [voiceError, setVoiceError] = useState("");

  // Background Voice Service (Python - Always Active)
  const [voiceService, setVoiceService] = useState<VoiceStatus>({
    online: false, status: "offline", wakeWordActive: false, listening: false, speaking: false, processing: false, muted: false, paused: false, error: null,
  });

  // Memories
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryInput, setMemoryInput] = useState("");
  const [memoryCategory, setMemoryCategory] = useState("general");
  const [memorySaving, setMemorySaving] = useState(false);

  // Approvals
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);

  // System
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);

  // Settings
  const [selectedProvider, setSelectedProvider] = useState("ollama");

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const manualRecognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const sendingRef = useRef(false);
  const browserVoiceEnabledRef = useRef(true);
  const messagesRef = useRef<Message[]>(messages);

  // Sync refs
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => { sendingRef.current = sending; }, [sending]);
  useEffect(() => { browserVoiceEnabledRef.current = browserVoiceEnabled; }, [browserVoiceEnabled]);

  // ── Scroll to bottom ──────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  // ── Backend polling ───────────────────────────────────────────────────────
  useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch(`${API}/api/health`);
        const data = await r.json();
        setBackendOnline(r.ok);
        if (r.ok) { setHealth(data); setProvider(data.provider ?? "ollama"); }
      } catch { setBackendOnline(false); }
    };
    void check();
    const t = setInterval(check, 10_000);
    return () => clearInterval(t);
  }, []);

  // ── Background voice service polling (every 2s for live state updates) ───
  useEffect(() => {
    const checkVoice = async () => {
      try {
        const r = await fetch(`${API}/api/voice/status`);
        if (r.ok) {
          const data: VoiceStatus = await r.json();
          setVoiceService(data);
        }
      } catch {
        setVoiceService(prev => ({ ...prev, online: false, status: "offline" }));
      }
    };
    void checkVoice();
    const t = setInterval(checkVoice, 2_000);
    return () => clearInterval(t);
  }, []);

  // ── Approvals polling ──────────────────────────────────────────────────────
  useEffect(() => {
    const check = async () => {
      try {
        const r = await fetch(`${API}/api/approvals`);
        if (r.ok) { const d = await r.json(); setApprovals(d.pending ?? []); }
      } catch { /* ignore */ }
    };
    void check();
    const t = setInterval(check, 3_000);
    return () => clearInterval(t);
  }, []);

  // ── System info ────────────────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        const [sr, gr] = await Promise.allSettled([
          fetch(`${API}/api/system/info`).then(r => r.json()),
          fetch(`${API}/api/git/status`).then(r => r.json()),
        ]);
        if (sr.status === "fulfilled") setSystemInfo(sr.value);
        if (gr.status === "fulfilled") setGitStatus(gr.value);
      } catch { /* ignore */ }
    };
    if (tab === "status") void load();
  }, [tab]);

  // ── Memories ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (tab !== "memories") return;
    fetch(`${API}/api/memories`).then(r => r.json()).then(d => setMemories(d.memories ?? [])).catch(() => {});
  }, [tab]);

  // ── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => () => {
    manualRecognitionRef.current?.abort();
    window.speechSynthesis?.cancel();
  }, []);

  // ── Speech helpers ────────────────────────────────────────────────────────

  function getSR(): SpeechRecognitionConstructor | null {
    const w = window as BrowserWindow;
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
  }

  const speakResponse = useCallback((text: string, onDone?: () => void) => {
    if (!browserVoiceEnabledRef.current || !("speechSynthesis" in window)) {
      setSpeaking(false); onDone?.(); return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-IN"; u.rate = 1; u.pitch = 1;
    u.onstart = () => setSpeaking(true);
    u.onend = () => { setSpeaking(false); onDone?.(); };
    u.onerror = () => { setSpeaking(false); onDone?.(); };
    window.speechSynthesis.speak(u);
  }, []);

  // ── Send message ──────────────────────────────────────────────────────────

  async function sendText(text: string) {
    const clean = text.trim();
    if (!clean || sendingRef.current) return;

    setVoiceError("");
    sendingRef.current = true;
    setSending(true);

    const userMsg: Message = { role: "you", text: clean, timestamp: ts() };
    const prev = messagesRef.current;
    const withUser = [...prev, userMsg];
    messagesRef.current = withUser;
    setMessages(withUser);
    setInput("");

    let reply = "";

    try {
      const endpoint = agentMode ? `${API}/api/agent` : `${API}/api/chat`;
      const body = agentMode
        ? { message: clean }
        : { message: clean, history: prev.map(m => ({ role: m.role, text: m.text })) };

      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Request failed.");
      reply = data.reply || "I received an empty response, Sir.";
    } catch (err) {
      reply = `Sorry, I encountered an error. ${err instanceof Error ? err.message : "Unknown error."}`;
    }

    const jarvisMsg: Message = { role: "jarvis", text: reply, timestamp: ts() };
    const final = [...messagesRef.current, jarvisMsg];
    messagesRef.current = final;
    setMessages(final);

    sendingRef.current = false;
    setSending(false);

    speakResponse(reply);
  }

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); void sendText(input);
  };

  // ── Manual Dictation (Optional Browser Mic) ───────────────────────────────

  function toggleManualMic() {
    setVoiceError("");
    const SR = getSR();
    if (!SR) { setVoiceError("Manual browser dictation requires Chrome/Edge."); return; }
    if (sendingRef.current) { setVoiceError("Wait for JARVIS to finish responding."); return; }

    if (manualListening) {
      manualRecognitionRef.current?.stop();
      setManualListening(false);
      return;
    }

    window.speechSynthesis?.cancel();
    setSpeaking(false);

    try {
      const r = new SR();
      r.lang = "en-IN";
      r.continuous = false;
      r.interimResults = false;
      r.onresult = (e) => {
        const rawResults = e.results as unknown as Array<{ [i: number]: { transcript: string }; isFinal: boolean }>;
        const t = rawResults.map(res => res[0]?.transcript ?? "").join(" ").trim();
        if (t) { setInput(t); void sendText(t); }
      };
      r.onerror = (e) => {
        if (e.error === "not-allowed") setVoiceError("Microphone access denied.");
        else if (e.error === "no-speech") setVoiceError("Didn't catch any speech.");
        else if (e.error !== "aborted") setVoiceError(`Mic error: ${e.error}`);
        setManualListening(false);
      };
      r.onend = () => { setManualListening(false); manualRecognitionRef.current = null; };
      manualRecognitionRef.current = r;
      r.start();
      setManualListening(true);
    } catch {
      setManualListening(false);
      setVoiceError("Could not start microphone.");
    }
  }

  // ── Voice Service Control (Pause / Resume / Mute / Unmute) ────────────────

  async function sendVoiceControl(cmd: "pause" | "resume" | "mute" | "unmute") {
    try {
      const r = await fetch(`${API}/api/voice/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });
      if (r.ok) {
        if (cmd === "pause") {
          setVoiceService(prev => ({ ...prev, paused: true, status: "paused", wakeWordActive: false, listening: false }));
        } else if (cmd === "resume") {
          setVoiceService(prev => ({ ...prev, paused: false, status: "listening", wakeWordActive: true, listening: true }));
        } else if (cmd === "mute") {
          setVoiceService(prev => ({ ...prev, muted: true }));
        } else if (cmd === "unmute") {
          setVoiceService(prev => ({ ...prev, muted: false }));
        }
      }
    } catch {
      setVoiceError("Could not send control command to voice service.");
    }
  }

  // ── Memories ──────────────────────────────────────────────────────────────

  async function addMemory() {
    if (!memoryInput.trim()) return;
    setMemorySaving(true);
    try {
      const r = await fetch(`${API}/api/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: memoryInput.trim(), category: memoryCategory }),
      });
      if (r.ok) {
        setMemoryInput("");
        const res = await fetch(`${API}/api/memories`);
        if (res.ok) { const d = await res.json(); setMemories(d.memories ?? []); }
      }
    } finally { setMemorySaving(false); }
  }

  async function deleteMemory(id: number) {
    await fetch(`${API}/api/memories/${id}`, { method: "DELETE" });
    setMemories(prev => prev.filter(m => m.id !== id));
  }

  // ── Approvals ─────────────────────────────────────────────────────────────

  async function resolveApproval(id: string, approved: boolean) {
    await fetch(`${API}/api/approvals/${id}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved }),
    });
    setApprovals(prev => prev.filter(a => a.id !== id));
  }

  // ── Provider switch ────────────────────────────────────────────────────────

  async function switchProvider(p: string) {
    const r = await fetch(`${API}/api/provider`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: p }),
    });
    if (r.ok) { setProvider(p); setSelectedProvider(p); }
  }

  // ── Live Status Indicator Calculation ─────────────────────────────────────

  let assistantState = "AWAITING CONNECTION";
  if (backendOnline) {
    if (sending) {
      assistantState = `PROCESSING${agentMode ? " (AGENT)" : ""}`;
    } else if (!voiceService.online) {
      assistantState = "VOICE SERVICE OFFLINE";
    } else if (voiceService.error) {
      assistantState = `MIC ERROR: ${voiceService.error.toUpperCase()}`;
    } else if (voiceService.paused || voiceService.status === "paused") {
      assistantState = "VOICE SERVICE PAUSED";
    } else if (voiceService.speaking || voiceService.status === "speaking" || speaking) {
      assistantState = "SPEAKING";
    } else if (voiceService.processing || voiceService.status === "processing") {
      assistantState = "PROCESSING COMMAND";
    } else if (voiceService.listening || voiceService.status === "capturing" || manualListening) {
      assistantState = "LISTENING FOR COMMAND";
    } else if (voiceService.wakeWordActive || voiceService.status === "listening") {
      assistantState = "JARVIS IS LISTENING";
    } else if (voiceService.status === "starting") {
      assistantState = "VOICE SERVICE STARTING";
    } else {
      assistantState = "JARVIS IS READY";
    }
  }

  const pendingCount = approvals.length;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <main className="dashboard">
      {/* ── Top Bar ── */}
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">J</span>
          <div>
            <h1>J.A.R.V.I.S.</h1>
            <p>PERSONAL AI SYSTEM</p>
          </div>
        </div>

        <div className="topbar-right">
          {pendingCount > 0 && (
            <button className="approval-badge" onClick={() => setTab("approvals")}>
              {pendingCount} APPROVAL{pendingCount > 1 ? "S" : ""} PENDING
            </button>
          )}
          <div className="system-status">
            <span className={`status-dot ${backendOnline ? "online" : ""}`} />
            {backendOnline ? "ONLINE" : "OFFLINE"}
          </div>
          <div className="provider-badge">{provider.toUpperCase()}</div>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="hero">
        <p className="eyebrow">PERSONAL INTELLIGENCE INTERFACE</p>
        <h2>At your service, Sir.</h2>

        <div className="reactor">
          <div className="reactor-ring ring-one" />
          <div className="reactor-ring ring-two" />
          <div className="reactor-ring ring-three" />
          <div className="reactor-core">J</div>
        </div>

        <p className={`assistant-state ${sending || voiceService.processing ? "pulsing" : ""}`}>{assistantState}</p>

        <div className="voice-service-status">
          <span className={`vs-dot ${voiceService.online && !voiceService.error ? (voiceService.paused ? "paused" : "online") : ""}`} />
          <span>
            VOICE SERVICE: {voiceService.online ? voiceService.status.toUpperCase() : "OFFLINE"}
          </span>
          {voiceService.online && voiceService.muted && <span className="vs-badge">MUTED</span>}
          {voiceService.online && voiceService.paused && <span className="vs-badge">PAUSED</span>}
        </div>
      </section>

      {/* ── Navigation ── */}
      <nav className="nav-tabs">
        {(["chat", "agent", "memories", "approvals", "status", "settings"] as Tab[]).map(t => (
          <button
            key={t}
            className={`tab-btn ${tab === t ? "active" : ""}`}
            onClick={() => setTab(t)}
            id={`tab-${t}`}
          >
            {t === "approvals" && pendingCount > 0
              ? `APPROVALS (${pendingCount})`
              : t.toUpperCase()}
          </button>
        ))}
      </nav>

      {/* ── Chat Tab ── */}
      {tab === "chat" && (
        <section className="workspace">
          <div className="panel-heading">
            <div>
              <h3>Command Center</h3>
              <p>Conversational interface — {agentMode ? "AGENT mode (executes actions)" : "CHAT mode (conversation only)"}</p>
            </div>
            <label className="mode-toggle" title="Toggle between chat and agent mode">
              <input type="checkbox" checked={agentMode} onChange={e => setAgentMode(e.target.checked)} />
              <span className="mode-label">{agentMode ? "⚡ AGENT" : "💬 CHAT"}</span>
            </label>
          </div>

          <div className="messages" aria-live="polite">
            {messages.map((msg, i) => (
              <div key={i} className={`message ${msg.role}`}>
                <div className="message-header">
                  <span className="message-role">{msg.role === "jarvis" ? "JARVIS" : "YOU"}</span>
                  <span className="message-time">{msg.timestamp}</span>
                </div>
                <p>{msg.text}</p>
              </div>
            ))}
            {sending && (
              <div className="message jarvis thinking">
                <span className="message-role">JARVIS</span>
                <p><span className="dots"><span /><span /><span /></span></p>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <form className="command-form" onSubmit={handleSubmit}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder={agentMode ? "Give JARVIS a task to execute..." : "Ask JARVIS anything..."}
              aria-label="Message input"
              maxLength={4000}
              disabled={sending}
              id="chat-input"
            />
            <button type="submit" disabled={sending || !input.trim()} id="send-btn">
              {sending ? "…" : "Send ↗"}
            </button>
          </form>

          {/* ── Voice Controls ── */}
          <div className="voice-controls">
            <button
              id="btn-pause-voice"
              type="button"
              disabled={!voiceService.online}
              onClick={() => sendVoiceControl(voiceService.paused ? "resume" : "pause")}
              aria-pressed={voiceService.paused}
              className={voiceService.paused ? "voice-active" : ""}
              title="Pause or resume always-on background wake-word listening"
            >
              {voiceService.paused ? "▶️ Resume Listening" : "⏸️ Pause Listening"}
            </button>

            <button
              id="btn-mute-voice"
              type="button"
              disabled={!voiceService.online}
              onClick={() => sendVoiceControl(voiceService.muted ? "unmute" : "mute")}
              aria-pressed={voiceService.muted}
              title="Mute or unmute spoken responses from JARVIS"
            >
              {voiceService.muted ? "🔊 Unmute JARVIS" : "🔇 Mute JARVIS"}
            </button>

            <button
              id="btn-listen"
              type="button"
              onClick={toggleManualMic}
              disabled={sending}
              aria-pressed={manualListening}
              className={manualListening ? "voice-active" : ""}
              title="Click to dictate directly into the text input box"
            >
              {manualListening ? "⏹ Stop Mic" : "🎙️ Speak"}
            </button>

            <button
              id="btn-voice-toggle"
              type="button"
              onClick={() => {
                if (browserVoiceEnabledRef.current) {
                  window.speechSynthesis?.cancel();
                  setSpeaking(false);
                  browserVoiceEnabledRef.current = false;
                  setBrowserVoiceEnabled(false);
                } else {
                  browserVoiceEnabledRef.current = true;
                  setBrowserVoiceEnabled(true);
                  setVoiceError("");
                }
              }}
              aria-pressed={browserVoiceEnabled}
              title="Toggle browser text-to-speech for typed messages"
            >
              {browserVoiceEnabled ? "🔊 Browser Voice On" : "🔇 Browser Voice Off"}
            </button>

            {speaking && (
              <button
                id="btn-stop-speaking"
                type="button"
                onClick={() => { window.speechSynthesis?.cancel(); setSpeaking(false); }}
              >
                ⏹ Stop Speaking
              </button>
            )}
          </div>

          {/* ── Real Status Messages ── */}
          {voiceError && <p className="voice-error" role="alert">{voiceError}</p>}
          {voiceService.error && <p className="voice-error" role="alert">Microphone: {voiceService.error}</p>}

          {voiceService.online && (voiceService.status === "listening" || voiceService.wakeWordActive) && (
            <p className="voice-status">JARVIS is listening for the wake word. Say "Hey JARVIS" or "JARVIS" at any time.</p>
          )}
          {voiceService.online && (voiceService.status === "capturing" || voiceService.listening) && (
            <p className="voice-status">JARVIS is listening for your command…</p>
          )}
          {voiceService.online && (voiceService.status === "processing" || voiceService.processing) && (
            <p className="voice-status">JARVIS is processing your command…</p>
          )}
          {voiceService.online && (voiceService.status === "speaking" || voiceService.speaking) && (
            <p className="voice-status">JARVIS is speaking…</p>
          )}
          {voiceService.online && voiceService.paused && (
            <p className="voice-status">Wake-word listening is paused. Click Resume Listening to re-enable.</p>
          )}
          {!voiceService.online && (
            <p className="voice-status muted">Background voice service is offline. Run start-jarvis.ps1 or start-voice.ps1 to start listening.</p>
          )}
        </section>
      )}

      {/* ── Agent Tab ── */}
      {tab === "agent" && (
        <section className="workspace">
          <div className="panel-heading">
            <div><h3>Agent Actions</h3><p>Execute tasks on your PC directly</p></div>
          </div>
          <div className="agent-grid">
            {[
              { label: "⏰ What time is it?", cmd: "What time is it?" },
              { label: "📊 System info", cmd: "Show system information" },
              { label: "📁 Git status", cmd: "Check my git status" },
              { label: "🔒 Lock PC", cmd: "Lock my PC" },
              { label: "🌐 Open Chrome", cmd: "Open Chrome" },
              { label: "💻 Open VS Code", cmd: "Open VS Code" },
              { label: "📂 Open File Explorer", cmd: "Open File Explorer" },
              { label: "🎛️ Open Dashboard", cmd: "Open my dashboard" },
              { label: "🔍 GitHub status", cmd: "Check GitHub authentication status" },
              { label: "📋 Git diff", cmd: "Show git diff" },
            ].map(({ label, cmd }) => (
              <button
                key={cmd}
                className="agent-action-btn"
                disabled={sending}
                onClick={() => { setTab("chat"); setTimeout(() => void sendText(cmd), 100); setAgentMode(true); }}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="agent-custom">
            <p className="eyebrow">CUSTOM COMMAND</p>
            <form className="command-form" onSubmit={e => { e.preventDefault(); setTab("chat"); setAgentMode(true); setTimeout(() => void sendText(input), 100); }}>
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="Type any task for JARVIS to execute..."
                maxLength={4000}
                disabled={sending}
                id="agent-input"
              />
              <button type="submit" disabled={sending || !input.trim()}>Execute</button>
            </form>
          </div>
        </section>
      )}

      {/* ── Memories Tab ── */}
      {tab === "memories" && (
        <section className="workspace">
          <div className="panel-heading">
            <div><h3>Memory Management</h3><p>{memories.length} saved memories</p></div>
          </div>

          <div className="memory-add">
            <input
              value={memoryInput}
              onChange={e => setMemoryInput(e.target.value)}
              placeholder="Add a new memory…"
              maxLength={1000}
              id="memory-input"
            />
            <select value={memoryCategory} onChange={e => setMemoryCategory(e.target.value)} id="memory-category">
              {["general", "preference", "personal", "project", "task"].map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <button onClick={addMemory} disabled={memorySaving || !memoryInput.trim()} id="memory-save-btn">
              {memorySaving ? "Saving…" : "Save"}
            </button>
          </div>

          <div className="memories-list">
            {memories.length === 0 && <p className="empty-state">No saved memories yet, Sir.</p>}
            {memories.map(m => (
              <div key={m.id} className="memory-item">
                <div className="memory-content">
                  <span className="memory-badge">{m.category}</span>
                  <span>{m.content}</span>
                </div>
                <button
                  className="memory-delete"
                  onClick={() => deleteMemory(m.id)}
                  aria-label="Delete memory"
                  id={`del-mem-${m.id}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ── Approvals Tab ── */}
      {tab === "approvals" && (
        <section className="workspace">
          <div className="panel-heading">
            <div><h3>Approval Requests</h3><p>Actions awaiting your confirmation</p></div>
          </div>
          {approvals.length === 0 && <p className="empty-state">No pending approvals, Sir.</p>}
          {approvals.map(a => (
            <div key={a.id} className="approval-card">
              <div className="approval-header">
                <span className="approval-id">#{a.id}</span>
                <span className="approval-time">{new Date(a.createdAt).toLocaleTimeString()}</span>
              </div>
              <p className="approval-prompt">{a.prompt}</p>
              <div className="approval-actions">
                <button className="btn-approve" onClick={() => resolveApproval(a.id, true)} id={`approve-${a.id}`}>
                  ✓ Approve
                </button>
                <button className="btn-reject" onClick={() => resolveApproval(a.id, false)} id={`reject-${a.id}`}>
                  ✗ Reject
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* ── Status Tab ── */}
      {tab === "status" && (
        <section className="workspace">
          <div className="panel-heading">
            <div><h3>System Status</h3><p>Live diagnostics</p></div>
          </div>

          <div className="status-grid">
            <div className="status-card">
              <h4>Backend API</h4>
              <div className={`status-indicator ${backendOnline ? "ok" : "err"}`}>
                {backendOnline ? "● ONLINE" : "● OFFLINE"}
              </div>
              <p>Port 3000 · {health.version ?? "unknown"}</p>
            </div>

            <div className="status-card">
              <h4>AI Provider</h4>
              <div className="status-indicator ok">● {provider.toUpperCase()}</div>
              <p>
                Ollama: {health.providers?.ollama.available ? "✓" : "✗"} &nbsp;
                Gemini: {health.providers?.gemini.available ? "✓" : "✗"}
              </p>
            </div>

            <div className="status-card">
              <h4>Voice Service</h4>
              <div className={`status-indicator ${voiceService.online && !voiceService.error ? "ok" : "err"}`}>
                ● {voiceService.online ? voiceService.status.toUpperCase() : "OFFLINE"}
              </div>
              <p>Wake word: {voiceService.online && voiceService.status === "listening" ? "actively listening" : voiceService.status}</p>
            </div>

            <div className="status-card">
              <h4>Memory (SQLite)</h4>
              <div className="status-indicator ok">● {memories.length} entries</div>
              <p>Persistent across sessions</p>
            </div>
          </div>

          {systemInfo && (
            <div className="info-block">
              <h4>System</h4>
              <table className="info-table">
                <tbody>
                  <tr><td>Time</td><td>{systemInfo.time}</td></tr>
                  <tr><td>Date</td><td>{systemInfo.date}</td></tr>
                  <tr><td>Uptime</td><td>{systemInfo.uptime}</td></tr>
                  <tr><td>Hostname</td><td>{systemInfo.hostname}</td></tr>
                  <tr><td>CPU</td><td>{systemInfo.cpuModel} × {systemInfo.cpus}</td></tr>
                  <tr><td>RAM</td><td>{systemInfo.freeRamGB} / {systemInfo.totalRamGB} GB free</td></tr>
                  <tr><td>OS</td><td>Windows {systemInfo.release}</td></tr>
                </tbody>
              </table>
            </div>
          )}

          {gitStatus && (
            <div className="info-block">
              <h4>Git — JARVIS Project</h4>
              {gitStatus.success ? (
                <pre className="git-output">{gitStatus.branch && `Branch: ${gitStatus.branch}\n`}{gitStatus.status}</pre>
              ) : (
                <p className="err-text">{gitStatus.message}</p>
              )}
            </div>
          )}

          <div className="info-block">
            <h4>Phone Integration</h4>
            <p className="placeholder-text">
              Phone integration is not yet configured, Sir. To proceed, please provide your phone's
              operating system (Android / iOS) and model so I can identify the best supported
              connection method.
            </p>
          </div>
        </section>
      )}

      {/* ── Settings Tab ── */}
      {tab === "settings" && (
        <section className="workspace">
          <div className="panel-heading">
            <div><h3>Settings</h3><p>Configure JARVIS behaviour</p></div>
          </div>

          <div className="settings-group">
            <h4>AI Provider</h4>
            <p>Currently active: <strong>{provider.toUpperCase()}</strong></p>
            <div className="provider-btns">
              <button
                className={`provider-btn ${selectedProvider === "ollama" ? "active" : ""}`}
                onClick={() => switchProvider("ollama")}
                id="btn-provider-ollama"
              >
                🦙 Ollama (Local)
              </button>
              <button
                className={`provider-btn ${selectedProvider === "gemini" ? "active" : ""}`}
                onClick={() => switchProvider("gemini")}
                disabled={!health.providers?.gemini.available}
                id="btn-provider-gemini"
              >
                ✨ Gemini (Cloud)
              </button>
            </div>
            {!health.providers?.gemini.available && (
              <p className="settings-note">Gemini requires GEMINI_API_KEY in services/api/.env</p>
            )}
          </div>

          <div className="settings-group">
            <h4>Background Voice Service (Python — Always-On)</h4>
            <p className={voiceService.online && !voiceService.error ? "status-ok" : "status-err"}>
              Status: {voiceService.online ? voiceService.status.toUpperCase() : "Offline"}
              {voiceService.error && ` (${voiceService.error})`}
            </p>
            <p className="settings-note">
              The Python voice service starts automatically with JARVIS and listens continuously for "Hey JARVIS" or "JARVIS" using local openwakeword. No manual browser button is required.
            </p>
            <div className="voice-controls" style={{ marginTop: 10 }}>
              <button
                type="button"
                disabled={!voiceService.online}
                onClick={() => sendVoiceControl(voiceService.paused ? "resume" : "pause")}
              >
                {voiceService.paused ? "▶️ Resume Listening" : "⏸️ Pause Listening"}
              </button>
              <button
                type="button"
                disabled={!voiceService.online}
                onClick={() => sendVoiceControl(voiceService.muted ? "unmute" : "mute")}
              >
                {voiceService.muted ? "🔊 Unmute Voice" : "🔇 Mute Voice"}
              </button>
            </div>
          </div>

          <div className="settings-group">
            <h4>GitHub</h4>
            <p>Use the agent to check GitHub status: <em>"Check GitHub authentication status"</em></p>
            <p className="settings-note">
              To authenticate: open a terminal and run <code>gh auth login</code>
            </p>
          </div>

          <div className="settings-group">
            <h4>Phone Integration</h4>
            <p className="placeholder-text">
              Please provide your phone model and OS (Android/iOS) so I can determine
              the correct integration approach. The integration will be modular and require
              explicit pairing with authentication.
            </p>
          </div>

          <div className="settings-group">
            <h4>Startup</h4>
            <p>To enable automatic startup, run: <code>scripts\manage-jarvis.ps1 -Action enable-startup</code></p>
            <p className="settings-note">This requires your approval and will show a confirmation prompt.</p>
          </div>
        </section>
      )}

      <footer>JARVIS PERSONAL AI · BUILD 0.5.0 · BACKEND {backendOnline ? "ONLINE" : "OFFLINE"} · {new Date().getFullYear()}</footer>
    </main>
  );
}
