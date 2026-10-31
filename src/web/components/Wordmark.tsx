export function Wordmark({ large = false }: { large?: boolean }) {
  return (
    <div className={`wordmark ${large ? 'wordmark--large' : ''}`}>
      <span className="wordmark-mark" aria-hidden>
        <span className="mark-card mark-card--back" />
        <span className="mark-card mark-card--front" />
      </span>
      <span className="wordmark-text">Skillsui</span>
    </div>
  );
}
