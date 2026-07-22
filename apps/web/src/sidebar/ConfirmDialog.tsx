import { useEffect, useRef } from 'react';

export interface ConfirmRequest {
  title: string;
  /** Optional second line spelling out what the action does to other data. */
  body?: string;
  confirmLabel: string;
  onConfirm: () => void;
}

/**
 * Modal confirmation for destructive sidebar actions. Deletes are undoable, but
 * the delete buttons sit in a dense icon row where a misclick is easy — this is
 * the cheap guard in front of that. Cancel takes focus so Enter is always safe.
 */
export function ConfirmDialog({
  request,
  onCancel,
}: {
  request: ConfirmRequest;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="confirm-backdrop" onClick={onCancel}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={request.title}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="confirm-title">{request.title}</p>
        {request.body && <p className="confirm-body">{request.body}</p>}
        <div className="confirm-actions">
          <button type="button" ref={cancelRef} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              request.onConfirm();
              onCancel();
            }}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
