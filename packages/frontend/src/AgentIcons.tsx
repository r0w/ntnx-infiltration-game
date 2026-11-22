/**
 * Small outline icons for the scoreboard cards, drawn as inline SVG so they
 * stay crisp at any size and take the colour of the text around them.
 */
function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg className="agent-ico" viewBox="0 0 24 24" aria-hidden="true">
      {children}
    </svg>
  );
}

/** Resume: the triangle that goes with the two bars of {@link PauseIcon}. */
export function PlayIcon() {
  return (
    <Icon>
      <path d="M8 5v14l11-7z" />
    </Icon>
  );
}

/** Held at an admin gate. */
export function PauseIcon() {
  return (
    <Icon>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </Icon>
  );
}

/** Held by the lunch lock (the pack-wide pause). */
export function LunchIcon() {
  return (
    <Icon>
      <path d="M19 3v12h-5c-.023-3.681.184-7.406 5-12zm0 12v6h-1v-3M8 4v17M5 4v3a3 3 0 1 0 6 0V4" />
    </Icon>
  );
}

/** Step-by-step help used: a joker, the card that gets you out of a tight spot. */
export function HelpIcon() {
  return (
    <Icon>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path
        d="M12 7.8L13.12 10.76L16.28 10.91L13.81 12.89L14.65 15.94L12 14.2L9.36 15.94L10.19 12.89L7.72 10.91L10.88 10.76Z"
        fill="currentColor"
        stroke="none"
      />
    </Icon>
  );
}
