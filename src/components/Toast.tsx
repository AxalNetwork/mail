import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export interface ToastSpec {
  text: string;
  action?: string;
  onAction?: () => void;
  error?: boolean;
}

type ShowToast = (t: ToastSpec | string) => void;

const ToastCtx = createContext<ShowToast>(() => {});

export function useToast(): ShowToast {
  return useContext(ToastCtx);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastSpec | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback<ShowToast>((t) => {
    clearTimeout(timer.current);
    setToast(typeof t === 'string' ? { text: t } : t);
    timer.current = setTimeout(() => setToast(null), 6000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <div className={'toast' + (toast.error ? ' error' : '')} role="status" aria-live="polite">
          <span>{toast.text}</span>
          {toast.action && (
            <button className="action" onClick={() => { setToast(null); toast.onAction?.(); }}>{toast.action}</button>
          )}
          <button className="close" aria-label="Dismiss" onClick={() => setToast(null)}>×</button>
        </div>
      )}
    </ToastCtx.Provider>
  );
}

/** Error → readable toast text. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
