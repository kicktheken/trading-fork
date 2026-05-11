import { useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmDialogProps {
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onResult: (confirmed: boolean) => void;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onResult,
}: ConfirmDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onResult(false);
      if (e.key === 'Enter') onResult(true);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onResult]);

  return createPortal(
    <div
      className="confirm-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onResult(false);
      }}
    >
      <div className="confirm-card">
        <div className="confirm-title">{title}</div>
        <div className="confirm-body">{body}</div>
        <div className="confirm-actions">
          <button
            type="button"
            className="confirm-btn confirm-btn-cancel"
            onClick={() => onResult(false)}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`confirm-btn ${destructive ? 'confirm-btn-destructive' : 'confirm-btn-primary'}`}
            onClick={() => onResult(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Promise-based wrapper. Renders a transient ConfirmDialog rooted on document.body,
// resolves true/false on user choice, then removes itself. Lets callers
// `await confirm({...})` without managing state.
export function confirm(props: Omit<ConfirmDialogProps, 'onResult'>): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    // Lazy-load React DOM client to avoid a circular import at module init.
    import('react-dom/client').then(({ createRoot }) => {
      const root = createRoot(host);
      const cleanup = (result: boolean) => {
        root.unmount();
        host.remove();
        resolve(result);
      };
      root.render(<ConfirmDialog {...props} onResult={cleanup} />);
    });
  });
}
