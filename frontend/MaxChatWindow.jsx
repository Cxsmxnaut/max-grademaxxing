/**
 * MaxChatWindow.jsx — React + Tailwind port of the vanilla Max chat UI.
 * Open WebUI-inspired dark shell, folk.com typography. No dependencies
 * beyond react + tailwind.
 *
 *   <MaxChatWindow
 *     busy={pending}
 *     messages={messages}                    // [{ id, role: 'user'|'max'|'error', text }]
 *     onSend={async (text) => setMessages(m => [...m, await postToMax(text)])}
 *   />
 *
 * The component is pure UI: it owns no network logic and no state beyond
 * the draft input and the typing indicator.
 */
import { useEffect, useRef, useState } from 'react';

const DOTS = [0, 150, 300]; // ms stagger for the typing pulse

export default function MaxChatWindow({
  messages = [],
  onSend,
  busy = false,
  modelLabel = 'max · mesh',
  placeholder = 'ask max anything…',
}) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const canSend = draft.trim() !== '' && !busy;

  // auto-grow the borderless textarea (OWUI composer behaviour)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [draft]);

  // pin the thread to the newest message, instantly
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
  }, [messages, busy]);

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    onSend?.(text);
  };

  return (
    <div className="flex h-full flex-col bg-[#171717] text-[#ececec]" style={{ fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      {/* top bar — hairline, translucent */}
      <header className="relative z-10 flex flex-none items-center justify-between gap-3 border-b border-white/[.08] bg-[#171717]/80 px-5 py-3.5 backdrop-blur-xl">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="grid h-[22px] w-[22px] flex-none place-items-center rounded-lg bg-[#ececec] text-[12px] font-bold text-[#171717]">
            m
          </div>
          <div className="truncate text-[13.5px] font-semibold tracking-[-.01em]">
            max <span className="font-medium text-[#9b9b9b]">· grademaxxing</span>
          </div>
        </div>
        <div className="inline-flex flex-none items-center gap-1.5 rounded-full border border-white/[.08] bg-[#212121] px-2.5 py-1 font-mono text-[12px] text-[#9b9b9b]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#57d982] shadow-[0_0_6px_rgba(87,217,130,.7)]" />
          {modelLabel}
        </div>
      </header>

      {/* scroll thread */}
      <main ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-6 py-9">
          {messages.length === 0 && (
            <div className="py-[9vh] text-center">
              <div className="mb-3.5 font-mono text-[11px] uppercase tracking-[.18em] text-[#6e6e6e]">grademaxxing</div>
              <div className="mb-2.5 text-[clamp(26px,4vw,34px)] font-semibold leading-tight tracking-[-.03em]">ask max.</div>
              <p className="text-[14.5px] text-[#9b9b9b]">clear answers about your grades — with the math to back it up.</p>
            </div>
          )}

          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="flex animate-[rise_.18s_ease-out] flex-col items-end">
                <div className="max-w-[82%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-[#303030] px-4 py-2.5 text-[15px]">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={m.id} className="flex animate-[rise_.18s_ease-out] flex-col gap-1.5 text-left">
                <div className="font-mono text-[10.5px] uppercase tracking-[.16em] text-[#6e6e6e]">
                  {m.role === 'error' ? 'system' : 'max'}
                </div>
                <div className={`whitespace-pre-wrap break-words text-[15px] leading-[1.65] ${m.role === 'error' ? 'text-[#d9a05b] opacity-90' : ''}`}>
                  {m.text}
                </div>
              </div>
            )
          )}

          {busy && (
            <div className="flex flex-col gap-1.5">
              <div className="font-mono text-[10.5px] uppercase tracking-[.16em] text-[#6e6e6e]">max</div>
              <div className="inline-flex w-fit items-center gap-[5px] rounded-2xl rounded-tl-md border border-white/[.08] bg-[#212121] px-4 py-3">
                {DOTS.map((delay) => (
                  <span
                    key={delay}
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#9b9b9b]"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </main>

      {/* composer — borderless input in a soft rounded shell */}
      <footer className="flex-none px-3 pb-4 sm:px-5">
        <form
          className="mx-auto flex w-full max-w-3xl items-end gap-1 rounded-3xl border border-white/[.08] bg-[#212121] px-1.5 py-1.5 shadow-[0_8px_28px_rgba(0,0,0,.35)] transition focus-within:border-white/[.16] focus-within:shadow-[0_8px_28px_rgba(0,0,0,.35),0_0_0_3px_rgba(255,255,255,.04)]"
          onSubmit={(e) => { e.preventDefault(); submit(); }}
        >
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder={placeholder}
            aria-label="message max"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
            className="max-h-[180px] min-h-[44px] flex-1 resize-none border-none bg-transparent px-4 py-2.5 text-[15px] leading-normal text-[#ececec] outline-none placeholder:text-[#6e6e6e] caret-[#ececec]"
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label="send message"
            className="mx-0.5 my-1 grid h-9 w-9 flex-none place-items-center rounded-full transition-all duration-150 enabled:hover:-translate-y-px enabled:hover:bg-white enabled:active:scale-95 disabled:cursor-default disabled:bg-[#333] disabled:text-[#6b6b6b] bg-[#ececec] text-[#171717]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-[17px] w-[17px]">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </form>
        <p className="mx-auto mt-2.5 max-w-3xl text-center text-[11.5px] tracking-[.01em] text-[#6e6e6e]">
          max can make mistakes — double-check the math.
        </p>
      </footer>

      {/* keyframes referenced by animate-[rise_...] above */}
      <style>{`@keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }`}</style>
    </div>
  );
}
