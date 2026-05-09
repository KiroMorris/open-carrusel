"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { ChatMessage } from "./ChatMessage";
import { ChatInput } from "./ChatInput";
import { ReferenceImages } from "./ReferenceImages";
import { AlertCircle, Plug, ImagePlus, Plus, History, Trash2, X, Lock } from "lucide-react";
import type { ReferenceImage } from "@/types/carousel";

interface ArchivedChat {
  id: string;
  sessionId: string | null;
  messages: { id: string; role: "user" | "assistant"; content: string }[];
  title: string;
  createdAt: number;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface ChatPanelProps {
  carouselId: string;
  referenceImages?: ReferenceImage[];
  claudeAvailable: boolean;
  onStreamStart?: () => void;
  onStreamEnd?: () => void;
  chatInputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Phase 5: when true, the active slide has non-empty canvasOverrides, so
   *  Claude's PUT/DELETE will be rejected with HTTP 423. We surface a banner
   *  above the input to warn the user before they send. */
  activeSlideLocked?: boolean;
  /** ID of the active slide — needed by the banner's "Unlock" button. */
  activeSlideId?: string | null;
  /** Active slide's 1-based number for display in the banner. */
  activeSlideNumber?: number | null;
  /** Called after the banner's "Unlock" button POSTs to the unlock endpoint
   *  so the parent can refetch the carousel. */
  onSlideUnlocked?: () => void;
}

export function ChatPanel({
  carouselId,
  claudeAvailable,
  referenceImages = [],
  onStreamStart,
  onStreamEnd,
  chatInputRef,
  activeSlideLocked = false,
  activeSlideId = null,
  activeSlideNumber = null,
  onSlideUnlocked,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dropUploading, setDropUploading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<ArchivedChat[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const dragCounterRef = useRef(0);

  const HISTORY_KEY = `chat-history-${carouselId}`;
  const SESSION_KEY = `chat-session-${carouselId}`;
  const MESSAGES_KEY = `chat-messages-${carouselId}`;

  const loadHistory = useCallback((): ArchivedChat[] => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [HISTORY_KEY]);

  const saveHistory = useCallback(
    (h: ArchivedChat[]) => {
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
      } catch {
        // ignore quota
      }
    },
    [HISTORY_KEY]
  );

  const uploadFiles = useCallback(
    async (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      setDropUploading(true);
      try {
        for (const file of images) {
          const formData = new FormData();
          formData.append("file", file);
          const uploadRes = await fetch("/api/upload", {
            method: "POST",
            body: formData,
          });
          if (!uploadRes.ok) continue;
          const uploadData = await uploadRes.json();
          await fetch(`/api/carousels/${carouselId}/references`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: uploadData.url,
              name: file.name,
            }),
          });
        }
        onStreamEnd?.();
      } finally {
        setDropUploading(false);
      }
    },
    [carouselId, onStreamEnd]
  );

  // Track whether we've finished hydrating so we don't overwrite localStorage
  // with the empty initial state during first render.
  const hydratedRef = useRef(false);

  // Load session ID and chat history from localStorage on mount / carousel switch
  useEffect(() => {
    hydratedRef.current = false;
    const storedSession = localStorage.getItem(`chat-session-${carouselId}`);
    setSessionId(storedSession || null);
    try {
      const storedMessages = localStorage.getItem(`chat-messages-${carouselId}`);
      setMessages(storedMessages ? JSON.parse(storedMessages) : []);
    } catch {
      setMessages([]);
    }
    // Defer marking hydrated so the persistence effect below
    // doesn't run with the previous carousel's stale state.
    const t = setTimeout(() => { hydratedRef.current = true; }, 0);
    return () => clearTimeout(t);
  }, [carouselId]);

  // Persist messages to localStorage on EVERY change (after hydration)
  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      if (messages.length === 0) {
        localStorage.removeItem(`chat-messages-${carouselId}`);
      } else {
        localStorage.setItem(`chat-messages-${carouselId}`, JSON.stringify(messages));
      }
    } catch {
      // ignore quota errors
    }
  }, [messages, carouselId]);

  // Persist sessionId on EVERY change too
  useEffect(() => {
    if (!hydratedRef.current) return;
    try {
      if (sessionId) {
        localStorage.setItem(`chat-session-${carouselId}`, sessionId);
      } else {
        localStorage.removeItem(`chat-session-${carouselId}`);
      }
    } catch {
      // ignore
    }
  }, [sessionId, carouselId]);

  // Legacy callback kept for compatibility with the streaming code below.
  const persistMessages = useCallback((_msgs: Message[]) => {
    // The effect above handles persistence automatically.
  }, []);

  // "New Chat": archive current → clear → start fresh next message
  // Reads fresh from localStorage so it works even if React state is stale.
  const handleNewChat = useCallback(() => {
    console.log("[chat] + New clicked");
    let currentMessages: typeof messages = [];
    let currentSessionId: string | null = null;
    try {
      const raw = localStorage.getItem(MESSAGES_KEY);
      if (raw) currentMessages = JSON.parse(raw);
    } catch (err) {
      console.warn("[chat] failed to parse stored messages, falling back", err);
      currentMessages = messages;
    }
    currentSessionId = localStorage.getItem(SESSION_KEY) ?? sessionId ?? null;
    console.log("[chat] archiving", currentMessages.length, "messages");

    if (currentMessages.length > 0) {
      const firstUser = currentMessages.find((m) => m.role === "user");
      const title = firstUser
        ? firstUser.content.slice(0, 60)
        : "Untitled chat";
      const archived: ArchivedChat = {
        id: crypto.randomUUID(),
        sessionId: currentSessionId,
        messages: currentMessages,
        title,
        createdAt: Date.now(),
      };
      const existing = loadHistory();
      const next = [archived, ...existing].slice(0, 50);
      console.log("[chat] saving history with", next.length, "items");
      saveHistory(next);
      setHistory(next);
    } else {
      console.log("[chat] nothing to archive — message list empty");
    }
    setMessages([]);
    setSessionId(null);
    localStorage.removeItem(MESSAGES_KEY);
    localStorage.removeItem(SESSION_KEY);
  }, [messages, sessionId, loadHistory, saveHistory, MESSAGES_KEY, SESSION_KEY]);

  const handleResumeArchived = useCallback(
    (chat: ArchivedChat) => {
      // Archive what's currently open if it has anything new
      if (messages.length > 0) {
        const firstUser = messages.find((m) => m.role === "user");
        const title = firstUser ? firstUser.content.slice(0, 60) : "Untitled chat";
        const current: ArchivedChat = {
          id: crypto.randomUUID(),
          sessionId,
          messages,
          title,
          createdAt: Date.now(),
        };
        const withCurrent = [current, ...loadHistory().filter((c) => c.id !== chat.id)].slice(0, 50);
        saveHistory(withCurrent);
        setHistory(withCurrent);
      }
      setMessages(chat.messages);
      setSessionId(chat.sessionId);
      try {
        localStorage.setItem(MESSAGES_KEY, JSON.stringify(chat.messages));
        if (chat.sessionId) {
          localStorage.setItem(SESSION_KEY, chat.sessionId);
        } else {
          localStorage.removeItem(SESSION_KEY);
        }
      } catch {
        // ignore
      }
      setShowHistory(false);
    },
    [messages, sessionId, loadHistory, saveHistory, MESSAGES_KEY, SESSION_KEY]
  );

  const handleDeleteArchived = useCallback(
    (id: string) => {
      const next = loadHistory().filter((c) => c.id !== id);
      saveHistory(next);
      setHistory(next);
    },
    [loadHistory, saveHistory]
  );

  const handleOpenHistory = useCallback(() => {
    setHistory(loadHistory());
    setShowHistory(true);
  }, [loadHistory]);

  // Synthetic "current" entry shown at the top of the history drawer.
  const currentEntry: (ArchivedChat & { isCurrent: true }) | null =
    messages.length > 0
      ? {
          id: "__current__",
          sessionId,
          messages,
          title:
            messages.find((m) => m.role === "user")?.content.slice(0, 60) ||
            "Current chat",
          createdAt: Date.now(),
          isCurrent: true,
        }
      : null;

  const handleStopGenerating = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Phase 5: unlock the active slide from the chat banner. We default to
  // keepText=true so the visual stays the same after the override metadata is
  // baked into the HTML.
  const [unlocking, setUnlocking] = useState(false);
  const handleUnlockActiveSlide = useCallback(async () => {
    if (!activeSlideId || unlocking) return;
    setUnlocking(true);
    try {
      const res = await fetch(
        `/api/carousels/${carouselId}/slides/${activeSlideId}/unlock?keepText=true`,
        { method: "POST" }
      );
      if (res.ok) {
        onSlideUnlocked?.();
      }
    } finally {
      setUnlocking(false);
    }
  }, [activeSlideId, carouselId, onSlideUnlocked, unlocking]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = useCallback(
    async (message: string) => {
      if (isStreaming) return;
      setError(null);
      setIsStreaming(true);
      onStreamStart?.();

      // Add user message
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: message,
      };
      setMessages((prev) => [...prev, userMsg]);

      // Add empty assistant message for streaming
      const assistantId = crypto.randomUUID();
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "" },
      ]);

      abortRef.current = new AbortController();

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message,
            sessionId,
            carouselId,
          }),
          signal: abortRef.current.signal,
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(
            (err as { error?: string }).error || "Failed to connect to AI"
          );
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response stream");

        const decoder = new TextDecoder();
        let accumulated = "";
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.type === "token" && typeof data.text === "string") {
                  accumulated += data.text;
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, content: accumulated }
                        : m
                    )
                  );
                } else if (data.type === "result" && typeof data.text === "string") {
                  accumulated = data.text; // result is the final complete text
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantId
                        ? { ...m, content: accumulated }
                        : m
                    )
                  );
                }
              } catch {
                // skip unparseable
              }
            } else if (line.startsWith("event: done")) {
              // Next line has the done data
            } else if (
              line.startsWith("data: ") &&
              line.includes("sessionId")
            ) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.sessionId) {
                  setSessionId(data.sessionId);
                  localStorage.setItem(
                    `chat-session-${carouselId}`,
                    data.sessionId
                  );
                }
              } catch {
                // skip
              }
            }
          }
        }

        // Parse any remaining buffer for the done event
        if (buffer.trim()) {
          for (const line of buffer.split("\n")) {
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.sessionId) {
                  setSessionId(data.sessionId);
                  localStorage.setItem(
                    `chat-session-${carouselId}`,
                    data.sessionId
                  );
                }
              } catch {
                // skip
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        const message = err instanceof Error ? err.message : "An unexpected error occurred";
        setError(message);
        // Remove empty assistant message on error
        setMessages((prev) =>
          prev.filter(
            (m) => m.id !== assistantId || m.content.length > 0
          )
        );
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
        // Persist messages after stream completes
        setMessages((prev) => {
          persistMessages(prev);
          return prev;
        });
        onStreamEnd?.();
      }
    },
    [isStreaming, sessionId, carouselId, onStreamStart, onStreamEnd, persistMessages]
  );

  if (!claudeAvailable) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-6 text-center">
        <Plug className="h-10 w-10 text-muted-foreground mb-3" />
        <h3 className="font-semibold text-sm mb-1">Connect Claude CLI</h3>
        <p className="text-xs text-muted-foreground max-w-[200px]">
          Install Claude CLI to enable AI-powered carousel creation.{" "}
          <a
            href="https://docs.anthropic.com/en/docs/claude-code"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline"
          >
            Install guide
          </a>
        </p>
      </div>
    );
  }

  return (
    <div
      className="h-full flex flex-col relative"
      onDragEnter={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          dragCounterRef.current += 1;
          setIsDragging(true);
        }
      }}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
        }
      }}
      onDragLeave={() => {
        dragCounterRef.current -= 1;
        if (dragCounterRef.current <= 0) {
          dragCounterRef.current = 0;
          setIsDragging(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragCounterRef.current = 0;
        setIsDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) uploadFiles(files);
      }}
    >
      {(isDragging || dropUploading) && (
        <div className="absolute inset-0 z-40 bg-accent/15 backdrop-blur-[2px] border-2 border-dashed border-accent rounded-md flex flex-col items-center justify-center pointer-events-none">
          <ImagePlus className="h-10 w-10 text-accent mb-2" />
          <p className="text-sm font-medium text-accent">
            {dropUploading ? "Uploading..." : "Drop images to add as references"}
          </p>
          <p className="text-xs text-accent/70 mt-1">
            Multiple images supported
          </p>
        </div>
      )}
      <div className="px-4 py-3 border-b border-border flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">AI Assistant</h2>
          <p className="text-xs text-muted-foreground truncate">
            Describe the carousel you want to create
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleNewChat}
            disabled={messages.length === 0}
            title="Start a new chat (current chat saved to history)"
            className="text-[11px] flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 transition-colors px-2 py-1 rounded"
          >
            <Plus className="h-3 w-3" />
            New
          </button>
          <button
            onClick={handleOpenHistory}
            title="View chat history for this carousel"
            className="text-[11px] flex items-center gap-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors px-2 py-1 rounded"
          >
            <History className="h-3 w-3" />
            History
          </button>
        </div>
      </div>

      <ReferenceImages
        carouselId={carouselId}
        images={referenceImages}
        onImagesChange={() => onStreamEnd?.()}
      />

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {messages.length === 0 && (
          <div className="p-6 text-center text-muted-foreground">
            <p className="text-sm mb-1">No messages yet</p>
            <p className="text-xs">
              Tell me what carousel you&apos;d like to create
            </p>
          </div>
        )}
        {messages.map((msg) => (
          <ChatMessage
            key={msg.id}
            role={msg.role}
            content={msg.content}
            isStreaming={
              isStreaming &&
              msg.role === "assistant" &&
              msg.id === messages[messages.length - 1]?.id
            }
          />
        ))}
        {error && (
          <div className="mx-4 my-2 flex items-center gap-2 text-destructive text-xs bg-destructive/10 rounded-lg p-3">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
      </div>

      {/* Phase 5: locked-from-chat banner. Shown when the active slide has
          non-empty canvasOverrides AND the user has at least one chat message
          (so we don't pre-shame an empty session). */}
      {activeSlideLocked && messages.length > 0 && (
        <div className="mx-3 mb-2 flex items-start gap-2 text-[11px] bg-accent/10 border border-accent/30 rounded-md px-2.5 py-2">
          <Lock className="h-3.5 w-3.5 shrink-0 mt-0.5" style={{ color: "var(--accent)" }} />
          <div className="flex-1 leading-snug">
            Slide{activeSlideNumber != null ? ` ${activeSlideNumber}` : ""} is locked from chat edits.{" "}
            <button
              type="button"
              onClick={handleUnlockActiveSlide}
              disabled={unlocking || !activeSlideId}
              className="underline font-medium hover:no-underline disabled:opacity-50"
              style={{ color: "var(--accent)" }}
            >
              {unlocking ? "Unlocking…" : "Unlock"}
            </button>{" "}
            it via the canvas toolbar to let Claude modify it.
          </div>
        </div>
      )}

      <ChatInput
        onSend={handleSend}
        isStreaming={isStreaming}
        textareaRef={chatInputRef}
        onStop={handleStopGenerating}
      />

      {/* History drawer */}
      {showHistory && (
        <div className="absolute inset-0 z-30 bg-background flex flex-col">
          <div className="px-4 py-3 border-b border-border flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold">Chat history</h3>
              <p className="text-xs text-muted-foreground">
                Past chats for this carousel
              </p>
            </div>
            <button
              onClick={() => setShowHistory(false)}
              className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted"
              aria-label="Close history"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {!currentEntry && history.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground">
                <History className="h-6 w-6 mx-auto mb-2 opacity-40" />
                <p className="text-sm">No chats yet</p>
                <p className="text-xs mt-1">
                  Send a message to start your first chat.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {currentEntry && (
                  <li className="group">
                    <div className="flex items-start gap-2 px-4 py-3 bg-accent/8 border-l-2 border-accent">
                      <button
                        onClick={() => setShowHistory(false)}
                        className="flex-1 text-left min-w-0"
                      >
                        <div className="text-xs font-medium truncate flex items-center gap-2">
                          <span className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wider bg-accent text-accent-foreground px-1.5 py-0.5 rounded">
                            Active
                          </span>
                          <span className="truncate">{currentEntry.title}</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-1">
                          {currentEntry.messages.length} message
                          {currentEntry.messages.length === 1 ? "" : "s"} ·
                          tap to view
                        </div>
                      </button>
                    </div>
                  </li>
                )}
                {history.map((c) => (
                  <li key={c.id} className="group">
                    <div className="flex items-start gap-2 px-4 py-3 hover:bg-muted/50">
                      <button
                        onClick={() => handleResumeArchived(c)}
                        className="flex-1 text-left min-w-0"
                      >
                        <div className="text-xs font-medium truncate">
                          {c.title}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-2">
                          <span>{new Date(c.createdAt).toLocaleString()}</span>
                          <span>·</span>
                          <span>
                            {c.messages.length} message
                            {c.messages.length === 1 ? "" : "s"}
                          </span>
                        </div>
                      </button>
                      <button
                        onClick={() => handleDeleteArchived(c.id)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive p-1"
                        aria-label="Delete archived chat"
                        title="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
