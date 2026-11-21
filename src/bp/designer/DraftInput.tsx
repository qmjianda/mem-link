import { useEffect, useId, useRef, useState } from 'react';

type CommitResult = boolean | { ok: boolean; message?: string } | void;

interface Props {
  value: string;
  onCommit: (value: string) => CommitResult;
  ariaLabel: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  inputMode?: 'text' | 'numeric' | 'decimal';
  onInvalid?: (message: string) => void;
  /** Called when Escape reverts; useful for closing a transient editor. */
  onCancel?: () => void;
}

function resultOf(value: CommitResult): { ok: boolean; message?: string } {
  if (value === false) return { ok: false };
  if (value && typeof value === 'object') return value;
  return { ok: true };
}

/**
 * Draft text/number input. Commits once on blur or Enter, reverts on Escape,
 * and never writes each keystroke into document history.
 */
export default function DraftInput({
  value, onCommit, ariaLabel, className = '', placeholder, disabled, inputMode = 'text', onInvalid, onCancel,
}: Props) {
  const [text, setText] = useState(value);
  const [error, setError] = useState<string | undefined>();
  const focused = useRef(false);
  const cancelBlur = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  useEffect(() => {
    if (!focused.current) setText(value);
  }, [value]);

  const commit = (fromBlur: boolean) => {
    if (text === value) { setError(undefined); return; }
    const result = resultOf(onCommit(text));
    if (result.ok) {
      setError(undefined);
      return;
    }
    const message = result.message || '输入无效';
    setError(message);
    if (fromBlur) {
      setText(value);
      setError(undefined);
      onInvalid?.(message);
    } else {
      inputRef.current?.focus();
    }
  };

  return (
    <span className="bp-draft">
      <input
        ref={inputRef}
        className={`in mono ${className}${error ? ' bad' : ''}`}
        aria-label={ariaLabel}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        inputMode={inputMode}
        spellCheck={false}
        onFocus={(e) => {
          focused.current = true;
          cancelBlur.current = false;
          e.currentTarget.select();
        }}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(undefined);
        }}
        onBlur={() => {
          focused.current = false;
          if (cancelBlur.current) {
            cancelBlur.current = false;
            setText(value);
            setError(undefined);
            return;
          }
          commit(true);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            commit(false);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            // Blur fires synchronously: mark it so onBlur does not commit the
            // draft that Escape is supposed to discard.
            cancelBlur.current = true;
            setText(value);
            setError(undefined);
            inputRef.current?.blur();
            onCancel?.();
          }
        }}
      />
      {error && <span id={errorId} className="bp-draft-error" role="alert">{error}</span>}
    </span>
  );
}
