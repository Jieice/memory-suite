type JsonBlockProps<T> = {
  title: string;
  value: T | null | T[];
  empty: string;
};

export function JsonBlock<T>({ title, value, empty }: JsonBlockProps<T>) {
  const hasValue = Array.isArray(value) ? value.length > 0 : value !== null;
  const meta = Array.isArray(value) ? `${value.length} 条` : hasValue ? '最新快照' : '空';

  return (
    <div className="json-block">
      <div className="json-block-head">
        <p className="eyebrow">{title}</p>
        <span className="status-pill">{meta}</span>
      </div>
      <pre>{hasValue ? JSON.stringify(value, null, 2) : empty}</pre>
    </div>
  );
}
