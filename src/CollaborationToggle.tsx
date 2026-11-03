export function CollaborationToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label="联动"
      title="开启时包含联动干员，关闭时隐藏"
      aria-checked={checked}
      data-collaboration-toggle
      className="collaboration-toggle"
      onClick={() => onChange(!checked)}
    >
      <span>联动</span>
      <span className="collaboration-switch" aria-hidden="true">
        <span />
      </span>
    </button>
  );
}
