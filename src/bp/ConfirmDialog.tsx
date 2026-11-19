/**
 * 工作区确认对话框：替换图、覆盖未导出内容、导出缺失来源时使用。
 * 与浏览器原生 confirm 不同，它提供明确的取消入口、可读的标题，
 * 并能把焦点限制在对话框内、关闭后还给触发控件。
 */
import { useModalFocus } from './ModalFocus';

export interface ConfirmRequest {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 可选第三动作，例如「导出当前图」；执行后由调用方决定是否关闭 */
  secondaryLabel?: string;
  onSecondary?: () => void;
  tone?: 'danger' | 'normal';
}

interface Props {
  request: ConfirmRequest;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ request, onConfirm, onCancel }: Props) {
  const ref = useModalFocus<HTMLDivElement>(onCancel);
  const titleId = 'bp-confirm-title';
  return (
    <div className="bp-overlay" role="presentation" onPointerDown={onCancel}>
      <div
        className="bp-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={ref}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="bp-confirm-title">{request.title}</h2>
        <p className="bp-confirm-body">{request.body}</p>
        <div className="bp-confirm-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            {request.cancelLabel ?? '取消'}
          </button>
          {request.secondaryLabel && (
            <button type="button" className="btn ghost" onClick={() => request.onSecondary?.()}>
              {request.secondaryLabel}
            </button>
          )}
          <button
            type="button"
            className={`btn${request.tone === 'danger' ? ' danger' : ''}`}
            onClick={onConfirm}
          >
            {request.confirmLabel ?? '继续'}
          </button>
        </div>
      </div>
    </div>
  );
}
