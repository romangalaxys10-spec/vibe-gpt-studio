import { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  Terminal,
  Play,
  Copy,
  Check,
  Flame,
  ShieldCheck,
  Eye,
  EyeOff,
  Cpu,
  Zap,
  RefreshCw,
  Monitor,
  Plus,
  MessageSquare,
  Edit2,
  Trash2,
  Archive,
  Users,
  PlayCircle
} from 'lucide-react';
import confetti from 'canvas-confetti';

interface Session {
  id: string;
  title: string;
  mode: 'vibe_code' | 'agent' | 'brainstorm' | 'chat';
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

interface Message {
  id: string;
  sender: 'user' | 'chatgpt' | 'system';
  text: string;
  mode: string;
  timestamp: string;
  extractedCode?: string[];
}

export default function App() {
  const [provider, setProvider] = useState<'chatgpt' | 'qwen'>('chatgpt');
  const [mode, setMode] = useState<'vibe_code' | 'agent' | 'brainstorm' | 'chat'>('vibe_code');
  const [inputPrompt, setInputPrompt] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isThinking, setIsThinking] = useState(false);
  const [headful, setHeadful] = useState(false);
  const [firefoxOk, setFirefoxOk] = useState<boolean | null>(null);
  const [cookieCount, setCookieCount] = useState<number>(0);
  const [qwenCookieCount, setQwenCookieCount] = useState<number>(0);
  const [terminalLogs, setTerminalLogs] = useState<string>('[System Initialized] Local Ubuntu Vibe GPT Studio active.\n');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activePreviewCode, setActivePreviewCode] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<'terminal' | 'preview' | 'subagents'>('terminal');
  const [subAgents, setSubAgents] = useState<any[]>([]);
  const [selectedSubAgentId, setSelectedSubAgentId] = useState<string | null>(null);
  const [subAgentTaskInput, setSubAgentTaskInput] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const [showNewSessionModal, setShowNewSessionModal] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [newSessionMode, setNewSessionMode] = useState<'vibe_code' | 'agent' | 'brainstorm' | 'chat'>('vibe_code');

  useEffect(() => {
    // Connect WebSocket
    const ws = new WebSocket('ws://localhost:3099');
    wsRef.current = ws;

    ws.onopen = () => {
      setTerminalLogs(prev => prev + '[WebSocket] Connected to backend on port 3099\n');
      ws.send(JSON.stringify({ type: 'CHECK_FIREFOX' }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'INIT_SESSIONS' || data.type === 'SESSIONS_UPDATED') {
        setSessions(data.sessions || []);
        
        // Check URL search param for session ID
        const urlParams = new URLSearchParams(window.location.search);
        const urlSessionId = urlParams.get('session');

        const targetId = (urlSessionId && (data.sessions || []).some((x: Session) => x.id === urlSessionId)) 
          ? urlSessionId 
          : data.activeSessionId;

        if (targetId) {
          setActiveSessionId(targetId);
          const s = (data.sessions || []).find((x: Session) => x.id === targetId);
          if (s) {
            setMessages(s.messages || []);
            setMode(s.mode || 'vibe_code');
          }
          // Sync URL search param
          const newUrl = `${window.location.pathname}?session=${targetId}`;
          window.history.replaceState({ path: newUrl }, '', newUrl);
        }
      }

      if (data.type === 'SESSION_LOADED') {
        if (data.session) {
          setMessages(data.session.messages || []);
          setMode(data.session.mode || 'vibe_code');
          setActiveSessionId(data.session.id);
          const newUrl = `${window.location.pathname}?session=${data.session.id}`;
          window.history.pushState({ path: newUrl }, '', newUrl);
        }
      }

      if (data.type === 'SUBAGENTS_UPDATED') {
        setSubAgents(data.agents || []);
      }

      if (data.type === 'FIREFOX_STATUS') {
        setFirefoxOk(data.ok);
        if (data.ok) setCookieCount(data.cookieCount);
      }

      if (data.type === 'STATUS') {
        setIsThinking(data.status === 'thinking');
      }

      if (data.type === 'STREAM_TOKEN') {
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.sender === 'chatgpt' && last.id === 'streaming') {
            return [...prev.slice(0, -1), { ...last, text: data.text }];
          } else {
            return [...prev, {
              id: 'streaming',
              sender: 'chatgpt',
              text: data.text,
              mode: mode,
              timestamp: new Date().toLocaleTimeString()
            }];
          }
        });
      }

      if (data.type === 'PROMPT_COMPLETE') {
        if (data.sessions) {
          setSessions(data.sessions);
          const currentS = data.sessions.find((x: Session) => x.id === activeSessionId);
          if (currentS) setMessages(currentS.messages || []);
        } else {
          setMessages(prev => {
            const filtered = prev.filter(m => m.id !== 'streaming');
            return [...filtered, {
              id: Date.now().toString(),
              sender: 'chatgpt',
              text: data.response,
              mode: data.mode,
              timestamp: new Date().toLocaleTimeString(),
              extractedCode: data.extractedCode
            }];
          });
        }
        confetti({ particleCount: 40, spread: 60, origin: { y: 0.8 } });
      }

      if (data.type === 'TERMINAL_OUTPUT') {
        setTerminalLogs(prev => prev + data.output);
      }
    };

    return () => ws.close();
  }, [mode, activeSessionId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    if (!inputPrompt.trim() || isThinking) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      sender: 'user',
      text: inputPrompt,
      mode: mode,
      timestamp: new Date().toLocaleTimeString()
    };

    setMessages(prev => [...prev, userMsg]);
    wsRef.current?.send(JSON.stringify({
      type: 'PROMPT',
      prompt: inputPrompt,
      mode,
      provider
    }));

    setInputPrompt('');
  };

  const toggleHeadful = () => {
    const next = !headful;
    setHeadful(next);
    wsRef.current?.send(JSON.stringify({ type: 'TOGGLE_HEADFUL', headful: next }));
  };

  const handleRunCommand = (cmd: string) => {
    setTerminalLogs(prev => prev + `\n> Triggering execution of extracted code...\n`);
    wsRef.current?.send(JSON.stringify({
      type: 'EXEC_COMMAND',
      command: cmd
    }));
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', backgroundColor: '#0B0F17', overflow: 'hidden' }}>
      
      {/* SIDEBAR NAVIGATION & MODES */}
      <div style={{ width: '280px', minWidth: '280px', flexShrink: 0, backgroundColor: '#0F1420', borderRight: '1px solid #2A364F', display: 'flex', flexDirection: 'column', padding: '20px', overflow: 'hidden' }}>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
          <div style={{ padding: '10px', background: 'linear-gradient(135deg, #00F2FE, #9D4EDD)', borderRadius: '12px' }}>
            <Zap size={22} color="#fff" />
          </div>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 'bold' }} className="gradient-text">Vibe GPT Studio</h2>
            <span style={{ fontSize: '11px', color: '#94A3B8' }}>Firefox Automated Agent</span>
          </div>
        </div>

        {/* STATUS CARD */}
        <div className="glass" style={{ padding: '14px', borderRadius: '12px', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <span style={{ fontSize: '12px', color: '#94A3B8' }}>Firefox Session</span>
            {firefoxOk ? (
              <span style={{ fontSize: '11px', color: '#10B981', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <ShieldCheck size={14} /> Active ({cookieCount} cookies)
              </span>
            ) : (
              <span style={{ fontSize: '11px', color: '#EF4444' }}>Disconnected</span>
            )}
          </div>
          <button
            onClick={() => wsRef.current?.send(JSON.stringify({ type: 'CHECK_FIREFOX' }))}
            style={{ width: '100%', padding: '6px', background: '#1E293B', border: '1px solid #334155', borderRadius: '6px', color: '#F1F5F9', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
            <RefreshCw size={12} /> Sync Firefox Cookies
          </button>
        </div>

        {/* SESSIONS HISTORY MANAGER (TRAE / ZCODE IDE STYLE) */}
        <div style={{ marginBottom: '20px', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <label style={{ fontSize: '12px', color: '#94A3B8', fontWeight: 600 }}>
              SESSIONS HISTORY
            </label>
            <button
              onClick={() => {
                setNewSessionTitle(`Workspace ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
                setShowNewSessionModal(true);
              }}
              style={{
                padding: '4px 8px',
                background: 'linear-gradient(135deg, #00F2FE, #9D4EDD)',
                border: 'none',
                borderRadius: '6px',
                color: '#FFF',
                fontSize: '11px',
                fontWeight: 'bold',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '4px'
              }}>
              <Plus size={12} /> New
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {sessions.filter(s => showArchived ? true : !s.archived).map((session) => {
              const isActive = session.id === activeSessionId;
              const isEditing = editingSessionId === session.id;

              return (
                <div
                  key={session.id}
                  onClick={() => {
                    if (!isEditing && session.id !== activeSessionId) {
                      wsRef.current?.send(JSON.stringify({ type: 'SELECT_SESSION', sessionId: session.id }));
                      const newUrl = `${window.location.pathname}?session=${session.id}`;
                      window.history.pushState({ path: newUrl }, '', newUrl);
                    }
                  }}
                  style={{
                    padding: '8px 10px',
                    borderRadius: '8px',
                    border: isActive ? '1px solid #00F2FE' : '1px solid #2A364F',
                    background: isActive ? 'rgba(0, 242, 254, 0.1)' : '#151C28',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '8px'
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflow: 'hidden', flex: 1 }}>
                    <MessageSquare size={14} color={isActive ? '#00F2FE' : '#94A3B8'} />
                    {isEditing ? (
                      <input
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onBlur={() => {
                          wsRef.current?.send(JSON.stringify({ type: 'UPDATE_SESSION', sessionId: session.id, title: editingTitle }));
                          setEditingSessionId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            wsRef.current?.send(JSON.stringify({ type: 'UPDATE_SESSION', sessionId: session.id, title: editingTitle }));
                            setEditingSessionId(null);
                          }
                        }}
                        autoFocus
                        style={{ background: '#0B0F17', border: '1px solid #00F2FE', color: '#FFF', fontSize: '11px', padding: '2px 4px', borderRadius: '4px', width: '100%' }}
                      />
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                        <span style={{ fontSize: '12px', color: isActive ? '#F1F5F9' : '#94A3B8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {session.title}
                        </span>
                        <span style={{ fontSize: '9px', color: '#64748B', fontFamily: 'var(--font-mono)' }}>
                          ID: {session.id}
                        </span>
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingSessionId(session.id);
                        setEditingTitle(session.title);
                      }}
                      title="Rename Session"
                      style={{ background: 'none', border: 'none', color: '#64748B', cursor: 'pointer', padding: '2px' }}>
                      <Edit2 size={12} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        wsRef.current?.send(JSON.stringify({ type: 'UPDATE_SESSION', sessionId: session.id, archived: !session.archived }));
                      }}
                      title={session.archived ? 'Unarchive' : 'Archive'}
                      style={{ background: 'none', border: 'none', color: session.archived ? '#10B981' : '#64748B', cursor: 'pointer', padding: '2px' }}>
                      <Archive size={12} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        wsRef.current?.send(JSON.stringify({ type: 'DELETE_SESSION', sessionId: session.id }));
                      }}
                      title="Delete Session"
                      style={{ background: 'none', border: 'none', color: '#EF4444', cursor: 'pointer', padding: '2px' }}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: '8px' }}>
            <button
              onClick={() => setShowArchived(!showArchived)}
              style={{ background: 'none', border: 'none', color: '#64748B', fontSize: '11px', cursor: 'pointer' }}>
              {showArchived ? 'Hide Archived' : 'Show Archived Sessions'}
            </button>
          </div>
        </div>

        {/* BROWSER LAUNCH OPTIONS */}
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button
            onClick={() => {
              wsRef.current?.send(JSON.stringify({
                type: 'AGENTIC_ACTION',
                action: 'OPEN_URL_FIREFOX',
                url: 'http://localhost:5173'
              }));
            }}
            style={{
              width: '100%',
              padding: '9px',
              borderRadius: '8px',
              border: '1px solid #00F2FE',
              background: 'rgba(0, 242, 254, 0.1)',
              color: '#00F2FE',
              fontWeight: 600,
              fontSize: '12px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px'
            }}>
            <Monitor size={14} /> 1. Open IDE in Firefox / Browser
          </button>

          <button
            onClick={() => {
              wsRef.current?.send(JSON.stringify({
                type: 'AGENTIC_ACTION',
                action: 'SERVE_AND_OPEN_FIREFOX',
                code: activePreviewCode || '<h1>Vibe Coding Live Preview</h1><p>Generate code in chat to view live preview here.</p>'
              }));
            }}
            style={{
              width: '100%',
              padding: '9px',
              borderRadius: '8px',
              border: 'none',
              background: 'linear-gradient(135deg, #9D4EDD, #FF007A)',
              color: '#FFF',
              fontWeight: 600,
              fontSize: '12px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px'
            }}>
            <Zap size={14} /> 2. Open Preview in Firefox / Browser
          </button>

          <button
            onClick={toggleHeadful}
            style={{
              width: '100%',
              padding: '8px',
              borderRadius: '8px',
              border: '1px solid #334155',
              background: headful ? '#1E293B' : '#0F1420',
              color: '#94A3B8',
              fontWeight: 500,
              fontSize: '11px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              marginTop: '4px'
            }}>
            {headful ? <Eye size={14} /> : <EyeOff size={14} />}
            {headful ? 'ChatGPT Headful (Visible)' : 'ChatGPT Headless (Background)'}
          </button>
        </div>

      </div>

      {/* MAIN CHAT & VIBE STUDIO WORKSPACE */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100%' }}>
        
        {/* HEADER */}
        <div style={{ height: '60px', borderBottom: '1px solid #2A364F', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', backgroundColor: '#0F1420' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '14px', fontWeight: 600, color: '#94A3B8' }}>Active Workspace:</span>
            <span style={{ fontSize: '13px', background: '#1E293B', padding: '4px 10px', borderRadius: '6px', color: '#00F2FE', border: '1px solid #334155' }}>
              ubuntu@local (~/vibe-gpt-studio)
            </span>

            <span style={{ fontSize: '14px', fontWeight: 600, color: '#94A3B8' }}>AI Model Provider:</span>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as any)}
              style={{
                padding: '4px 10px',
                borderRadius: '6px',
                border: '1px solid #9D4EDD',
                background: 'rgba(157, 78, 221, 0.15)',
                color: '#FFF',
                fontSize: '12px',
                fontWeight: 'bold',
                outline: 'none',
                cursor: 'pointer'
              }}>
              <option value="chatgpt" style={{ background: '#0F1420', color: '#FFF' }}>🤖 OpenAI ChatGPT (chatgpt.com)</option>
              <option value="qwen" style={{ background: '#0F1420', color: '#FFF' }}>⚡ Qwen AI (chat.qwen.ai)</option>
            </select>

            <select
              value={mode}
              onChange={(e) => {
                const nextMode = e.target.value as any;
                setMode(nextMode);
                wsRef.current?.send(JSON.stringify({ type: 'UPDATE_SESSION', sessionId: activeSessionId, mode: nextMode }));
              }}
              style={{
                padding: '4px 10px',
                borderRadius: '6px',
                border: '1px solid #00F2FE',
                background: 'rgba(0, 242, 254, 0.1)',
                color: '#00F2FE',
                fontSize: '12px',
                fontWeight: 'bold',
                outline: 'none',
                cursor: 'pointer'
              }}>
              <option value="vibe_code" style={{ background: '#0F1420', color: '#FFF' }}>⚡ Vibe Coding Mode</option>
              <option value="agent" style={{ background: '#0F1420', color: '#FFF' }}>🤖 Agentic Loop Mode (Terminal & Tools)</option>
              <option value="brainstorm" style={{ background: '#0F1420', color: '#FFF' }}>💡 Brainstorming Mode</option>
              <option value="chat" style={{ background: '#0F1420', color: '#FFF' }}>💬 Free Chat Mode</option>
            </select>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            {isThinking && (
              <span style={{ fontSize: '12px', color: '#00F2FE', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Cpu className="spin" size={14} /> ChatGPT Automation Processing...
              </span>
            )}
          </div>
        </div>

        {/* CHAT MESSAGES AREA */}
        <div style={{ flex: 1, padding: '24px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          
          {messages.length === 0 && (
            <div style={{ margin: 'auto', textAlign: 'center', maxWidth: '520px' }}>
              <div className="glass-card" style={{ padding: '28px', borderRadius: '20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '16px' }}>
                <div style={{ padding: '16px', background: 'linear-gradient(135deg, rgba(0,242,254,0.15), rgba(157,78,221,0.15))', borderRadius: '16px', border: '1px solid rgba(0,242,254,0.3)' }}>
                  <Flame size={48} color="#00F2FE" />
                </div>
                <h3 style={{ fontSize: '22px', fontWeight: 'bold' }} className="gradient-text">Autonomous Vibe GPT Studio</h3>
                <p style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                  Directly integrated with your local Ubuntu environment. Execute shell diagnostic scripts, open & focus desktop applications, automate browser tasks, or vibe code with real-time Firefox cookie authentication.
                </p>
                <div style={{ display: 'flex', gap: '10px', marginTop: '6px' }}>
                  <button
                    onClick={() => {
                      setInputPrompt('check my linux health');
                      setMode('agent');
                    }}
                    style={{ padding: '8px 14px', borderRadius: '8px', background: '#1E293B', border: '1px solid #334155', color: '#00F2FE', fontSize: '12px', cursor: 'pointer', fontWeight: 600 }}>
                    ⚡ Check Linux Health
                  </button>
                  <button
                    onClick={() => {
                      setInputPrompt('open discord');
                      setMode('agent');
                    }}
                    style={{ padding: '8px 14px', borderRadius: '8px', background: '#1E293B', border: '1px solid #334155', color: '#9D4EDD', fontSize: '12px', cursor: 'pointer', fontWeight: 600 }}>
                    🤖 Open Discord
                  </button>
                </div>
              </div>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={msg.id === 'streaming' ? 'glow-active' : ''}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignSelf: msg.sender === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '80%',
                background: msg.sender === 'user' ? '#1E293B' : '#151C28',
                border: msg.sender === 'user' ? '1px solid #334155' : '1px solid #2A364F',
                borderRadius: '12px',
                padding: '16px',
                color: '#F1F5F9'
              }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ fontSize: '11px', fontWeight: 600, color: msg.sender === 'user' ? '#00F2FE' : '#9D4EDD', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {msg.sender === 'user' ? 'YOU' : provider === 'qwen' ? 'QWEN AI AUTOMATION' : 'CHATGPT AUTOMATION'}
                  {msg.id === 'streaming' && <span style={{ fontSize: '10px', color: '#00F2FE', animation: 'pulseGlow 1s infinite' }}>[STREAMING...]</span>}
                </span>
                <span style={{ fontSize: '10px', color: '#64748B' }}>{msg.timestamp}</span>
              </div>

              <div style={{ fontSize: '14px', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {/* For vibe_code mode with extracted code, skip raw text display - code blocks are shown below with preview buttons */}
                {!((msg.extractedCode && msg.extractedCode.length > 0) && msg.mode === 'vibe_code') && (
                  <>{msg.text}</>
                )}
              </div>

              {/* EXTRACTED CODE AUTO-EXECUTE BUTTONS */}
              {msg.extractedCode && msg.extractedCode.length > 0 && (
                <div style={{ marginTop: '14px', paddingTop: '12px', borderTop: '1px dashed #2A364F' }}>
                  <span style={{ fontSize: '11px', color: '#94A3B8', fontWeight: 'bold' }}>Detected Code / Commands:</span>
                  {msg.extractedCode.map((codeBlock, idx) => (
                    <div key={idx} style={{ marginTop: '8px', background: '#0B0F17', padding: '10px', borderRadius: '8px', border: '1px solid #1E293B' }}>
                      <pre style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', overflowX: 'auto', marginBottom: '8px' }}>
                        {codeBlock}
                      </pre>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button
                          onClick={() => handleRunCommand(codeBlock)}
                          style={{ padding: '4px 10px', background: '#10B981', color: '#FFF', border: 'none', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <Play size={12} /> Execute on Terminal
                        </button>
                        <button
                          onClick={() => {
                            setActivePreviewCode(codeBlock);
                            setRightTab('preview');
                          }}
                          style={{ padding: '4px 10px', background: '#00F2FE', color: '#0B0F17', fontWeight: 'bold', border: 'none', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <Monitor size={12} /> Built-in Live Preview
                        </button>
                        <button
                          onClick={() => {
                            wsRef.current?.send(JSON.stringify({
                              type: 'AGENTIC_ACTION',
                              action: 'SERVE_AND_OPEN_FIREFOX',
                              code: codeBlock
                            }));
                          }}
                          style={{ padding: '4px 10px', background: 'linear-gradient(135deg, #9D4EDD, #FF007A)', color: '#FFF', fontWeight: 'bold', border: 'none', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <Zap size={12} /> Preview Code in External Firefox
                        </button>
                        <button
                          onClick={() => copyToClipboard(codeBlock, `${msg.id}-${idx}`)}
                          style={{ padding: '4px 10px', background: '#1E293B', color: '#94A3B8', border: '1px solid #334155', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          {copiedId === `${msg.id}-${idx}` ? <Check size={12} color="#10B981" /> : <Copy size={12} />}
                          {copiedId === `${msg.id}-${idx}` ? 'Copied' : 'Copy Code'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* DYNAMIC TYPING & THINKING ANIMATION */}
          {(isThinking || messages.some(m => m.id === 'streaming')) && (
            <div style={{
              alignSelf: 'flex-start',
              background: '#151C28',
              border: '1px solid #00F2FE',
              borderRadius: '12px',
              padding: '14px 18px',
              display: 'flex',
              alignItems: 'center',
              gap: '12px'
            }} className="glow-active">
              <Cpu className="spin-slow" size={18} color="#00F2FE" />
              <span style={{ fontSize: '13px', color: '#00F2FE', fontWeight: 600 }}>
                {messages.some(m => m.id === 'streaming') 
                  ? `${provider === 'qwen' ? 'Qwen AI' : 'ChatGPT'} is streaming response...` 
                  : `${provider === 'qwen' ? 'Qwen AI' : 'ChatGPT'} is thinking & reasoning...`}
              </span>
              <div style={{ display: 'flex', gap: '5px', marginLeft: '6px' }}>
                <span className="typing-dot"></span>
                <span className="typing-dot"></span>
                <span className="typing-dot"></span>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* INPUT PROMPT AREA */}
        <div style={{ padding: '16px 24px', backgroundColor: '#0F1420', borderTop: '1px solid #2A364F' }}>
          <div style={{ display: 'flex', gap: '12px' }}>
            <textarea
              value={inputPrompt}
              onChange={(e) => setInputPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={`Ask ${provider === 'qwen' ? 'Qwen AI' : 'ChatGPT'} to vibe code, write scripts, or run local agent workflows (${mode} mode)...`}
              style={{
                flex: 1,
                backgroundColor: '#151C28',
                border: '1px solid #2A364F',
                borderRadius: '10px',
                padding: '12px',
                color: '#F1F5F9',
                fontSize: '14px',
                outline: 'none',
                resize: 'none',
                height: '54px'
              }}
            />
            <button
              onClick={handleSend}
              disabled={isThinking || !inputPrompt.trim()}
              style={{
                padding: '0 24px',
                background: isThinking ? '#334155' : 'linear-gradient(135deg, #00F2FE, #9D4EDD)',
                border: 'none',
                borderRadius: '10px',
                color: '#FFF',
                fontWeight: 'bold',
                fontSize: '14px',
                cursor: isThinking ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}>
              <Sparkles size={16} /> Send
            </button>
          </div>
        </div>

      </div>

      {/* RIGHT SIDEBAR - INTEGRATED UBUNTU TERMINAL & LIVE PREVIEW */}
      <div style={{ width: '420px', minWidth: '420px', flexShrink: 0, backgroundColor: '#0F1420', borderLeft: '1px solid #2A364F', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #2A364F', display: 'flex', gap: '8px', background: '#0B0F17' }}>
          <button
            onClick={() => setRightTab('terminal')}
            style={{
              padding: '6px 14px',
              borderRadius: '6px',
              border: rightTab === 'terminal' ? '1px solid #00F2FE' : '1px solid transparent',
              background: rightTab === 'terminal' ? 'rgba(0, 242, 254, 0.1)' : 'transparent',
              color: rightTab === 'terminal' ? '#00F2FE' : '#94A3B8',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}>
            <Terminal size={14} /> Terminal Logs
          </button>

          <button
            onClick={() => setRightTab('preview')}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: rightTab === 'preview' ? '1px solid #00F2FE' : '1px solid transparent',
              background: rightTab === 'preview' ? 'rgba(0, 242, 254, 0.1)' : 'transparent',
              color: rightTab === 'preview' ? '#00F2FE' : '#94A3B8',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}>
            <Monitor size={14} /> Live Canvas {activePreviewCode ? '●' : ''}
          </button>

          <button
            onClick={() => {
              setRightTab('subagents');
              fetch('http://localhost:3099/api/subagents').then(r => r.json()).then(data => setSubAgents(data));
            }}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: rightTab === 'subagents' ? '1px solid #00F2FE' : '1px solid transparent',
              background: rightTab === 'subagents' ? 'rgba(0, 242, 254, 0.1)' : 'transparent',
              color: rightTab === 'subagents' ? '#00F2FE' : '#94A3B8',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px'
            }}>
            <Users size={14} /> Sub-Agents
          </button>
        </div>

        {rightTab === 'terminal' ? (
          <div style={{ flex: 1, padding: '12px', background: '#0B0F17', overflowY: 'auto' }}>
            <pre style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: '#10B981', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
              {terminalLogs}
            </pre>
          </div>
        ) : rightTab === 'preview' ? (
          <div style={{ flex: 1, background: '#FFFFFF', display: 'flex', flexDirection: 'column' }}>
            {activePreviewCode ? (
              <iframe
                title="Vibe Coding Preview"
                srcDoc={activePreviewCode.includes('<html') || activePreviewCode.includes('<div') || activePreviewCode.includes('<style') ? activePreviewCode : `<!DOCTYPE html><html><head><style>body { background: #0b0f17; color: #fff; font-family: sans-serif; padding: 20px; }</style></head><body><pre>${activePreviewCode.replace(/</g, '&lt;')}</pre></body></html>`}
                style={{ width: '100%', height: '100%', border: 'none' }}
              />
            ) : (
              <div style={{ margin: 'auto', textAlign: 'center', padding: '20px', color: '#64748B' }}>
                <Monitor size={32} style={{ marginBottom: '8px', opacity: 0.5 }} />
                <p style={{ fontSize: '13px' }}>Click "Live Preview" on any generated code block to render it live here.</p>
              </div>
            )}
          </div>
        ) : (
          /* SUB-AGENTS ORCHESTRATOR PANEL */
          <div style={{ flex: 1, padding: '16px', background: '#0B0F17', display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'auto' }}>
            <div>
              <h4 style={{ fontSize: '14px', fontWeight: 'bold', color: '#F1F5F9', marginBottom: '4px' }}>Autonomous Sub-Agents</h4>
              <p style={{ fontSize: '11px', color: '#94A3B8' }}>Dispatch specialized sub-agents to analyze code, write unit tests, or perform security audits in background tasks.</p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {subAgents.map((agent) => {
                const isSelected = selectedSubAgentId === agent.id;
                return (
                  <div
                    key={agent.id}
                    onClick={() => setSelectedSubAgentId(agent.id)}
                    style={{
                      padding: '10px 12px',
                      borderRadius: '8px',
                      border: isSelected ? '1px solid #00F2FE' : '1px solid #2A364F',
                      background: isSelected ? 'rgba(0, 242, 254, 0.08)' : '#151C28',
                      cursor: 'pointer'
                    }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#F1F5F9' }}>{agent.name}</span>
                      <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', background: agent.status === 'busy' ? '#9D4EDD' : '#10B981', color: '#FFF' }}>
                        {agent.status.toUpperCase()}
                      </span>
                    </div>
                    <p style={{ fontSize: '11px', color: '#94A3B8' }}>{agent.systemPrompt}</p>
                  </div>
                );
              })}
            </div>

            {selectedSubAgentId && (
              <div style={{ padding: '12px', background: '#151C28', borderRadius: '8px', border: '1px solid #334155' }}>
                <label style={{ fontSize: '11px', color: '#00F2FE', fontWeight: 'bold', display: 'block', marginBottom: '6px' }}>
                  Dispatch Task to {subAgents.find(a => a.id === selectedSubAgentId)?.name}
                </label>
                <textarea
                  value={subAgentTaskInput}
                  onChange={(e) => setSubAgentTaskInput(e.target.value)}
                  placeholder="Task instructions (e.g. Write unit tests for current fibonacci function)..."
                  style={{ width: '100%', height: '60px', background: '#0B0F17', border: '1px solid #2A364F', borderRadius: '6px', color: '#FFF', padding: '8px', fontSize: '12px', resize: 'none', marginBottom: '8px' }}
                />
                <button
                  onClick={() => {
                    if (!subAgentTaskInput.trim()) return;
                    fetch('http://localhost:3099/api/subagents/task', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        agentId: selectedSubAgentId,
                        taskDescription: subAgentTaskInput,
                        parentSessionId: activeSessionId
                      })
                    }).then(() => {
                      setSubAgentTaskInput('');
                      alert('Sub-agent task dispatched! Results will stream into chat.');
                    });
                  }}
                  style={{ width: '100%', padding: '8px', background: 'linear-gradient(135deg, #00F2FE, #9D4EDD)', border: 'none', borderRadius: '6px', color: '#FFF', fontWeight: 'bold', fontSize: '12px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                  <PlayCircle size={14} /> Dispatch Sub-Agent Task
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* NEW SESSION MODE & AGENT SELECTOR MODAL */}
      {showNewSessionModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(5, 8, 22, 0.85)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div style={{
            width: '460px',
            backgroundColor: '#0F1420',
            border: '1px solid #00F2FE',
            borderRadius: '16px',
            padding: '24px',
            boxShadow: '0 20px 50px rgba(0, 0, 0, 0.6)',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 'bold', color: '#F1F5F9' }}>Create New Session Workspace</h3>
              <button
                onClick={() => setShowNewSessionModal(false)}
                style={{ background: 'none', border: 'none', color: '#64748B', cursor: 'pointer', fontSize: '16px' }}>✕</button>
            </div>

            <div>
              <label style={{ fontSize: '12px', color: '#94A3B8', fontWeight: 600, display: 'block', marginBottom: '6px' }}>
                Session Name
              </label>
              <input
                value={newSessionTitle}
                onChange={(e) => setNewSessionTitle(e.target.value)}
                placeholder="Session workspace title..."
                style={{ width: '100%', padding: '10px', background: '#0B0F17', border: '1px solid #2A364F', borderRadius: '8px', color: '#FFF', fontSize: '13px', outline: 'none' }}
              />
            </div>

            <div>
              <label style={{ fontSize: '12px', color: '#94A3B8', fontWeight: 600, display: 'block', marginBottom: '8px' }}>
                Select Agentic Workflow Mode
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                {[
                  { id: 'vibe_code', label: 'Vibe Coding', desc: 'Code generation & execution' },
                  { id: 'agent', label: 'Agentic Loop', desc: 'Terminal, Browser & Computer tools' },
                  { id: 'brainstorm', label: 'Brainstorming', desc: 'Architecture & prompt design' },
                  { id: 'chat', label: 'Free Chat', desc: 'Direct ChatGPT conversation' }
                ].map((item) => {
                  const isSelected = newSessionMode === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setNewSessionMode(item.id as any)}
                      style={{
                        padding: '12px',
                        borderRadius: '10px',
                        border: isSelected ? '1px solid #00F2FE' : '1px solid #2A364F',
                        background: isSelected ? 'rgba(0, 242, 254, 0.12)' : '#151C28',
                        color: isSelected ? '#00F2FE' : '#94A3B8',
                        textAlign: 'left',
                        cursor: 'pointer'
                      }}>
                      <div style={{ fontWeight: 'bold', fontSize: '13px', color: isSelected ? '#00F2FE' : '#F1F5F9' }}>{item.label}</div>
                      <div style={{ fontSize: '10px', color: '#64748B', marginTop: '2px' }}>{item.desc}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
              <button
                onClick={() => setShowNewSessionModal(false)}
                style={{ flex: 1, padding: '10px', background: '#151C28', border: '1px solid #2A364F', borderRadius: '8px', color: '#94A3B8', fontSize: '13px', cursor: 'pointer' }}>
                Cancel
              </button>
              <button
                onClick={() => {
                  wsRef.current?.send(JSON.stringify({
                    type: 'CREATE_SESSION',
                    title: newSessionTitle.trim() || 'New Session Workspace',
                    mode: newSessionMode
                  }));
                  setMode(newSessionMode);
                  setShowNewSessionModal(false);
                }}
                style={{ flex: 1, padding: '10px', background: 'linear-gradient(135deg, #00F2FE, #9D4EDD)', border: 'none', borderRadius: '8px', color: '#FFF', fontWeight: 'bold', fontSize: '13px', cursor: 'pointer' }}>
                Create Session
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
