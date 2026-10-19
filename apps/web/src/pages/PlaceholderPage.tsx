export function PlaceholderPage({ title }: { title: string }) {
  return (
    <div>
      <h1 className="m-0 text-2xl font-bold">{title}</h1>
      <p className="mt-1.5 text-muted">此页面在后续阶段实现。</p>
    </div>
  );
}
