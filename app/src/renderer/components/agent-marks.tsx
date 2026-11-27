import { useId } from "react";

// The coding agents' own marks in their own colours, for agents reached through ACP (Claude Code's
// and Codex's are in bits.tsx). Antigravity: its favicon (antigravity.google) without the round
// backdrop. OpenCode: its favicon (opencode.ai) without the dark square: the frame in the text
// colour, the inner block in its grey. The marks are their owners' trademarks.

export const AGENT_MARK_VIEWBOX: Record<string, string> = {
  antigravity: "7.6 9.8 96 96",
  opencode: "96 96 320 320",
};

function AntigravityMark() {
  // Masks and filters are found by id: one set per icon on the page.
  const id = useId().replace(/:/g, "");
  return (
    <>
      <path
        d="M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z"
        fill="#3186FF"
      />
      <mask
        id={`${id}m`}
        style={{ maskType: "alpha" }}
        maskUnits="userSpaceOnUse"
        x="13"
        y="18"
        width="85"
        height="78"
      >
        <path
          d="M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z"
          fill="black"
        />
      </mask>
      <g mask={`url(#${id}m)`}>
        <g filter={`url(#${id}f0)`}>
          <ellipse
            cx="22.7873"
            cy="26.8098"
            rx="22.7873"
            ry="26.8098"
            transform="matrix(-0.112784 0.99362 -0.99362 -0.112781 66.2473 -15.5344)"
            fill="#FFE432"
          />
        </g>
        <g filter={`url(#${id}f1)`}>
          <ellipse
            cx="96.491"
            cy="35.1231"
            rx="29.5007"
            ry="30.1492"
            transform="rotate(76.9243 96.491 35.1231)"
            fill="#FC413D"
          />
        </g>
        <g filter={`url(#${id}f2)`}>
          <ellipse
            cx="9.02988"
            cy="41.6647"
            rx="30.832"
            ry="39.9417"
            transform="rotate(74.1257 9.02988 41.6647)"
            fill="#00B95C"
          />
        </g>
        <g filter={`url(#${id}f3)`}>
          <ellipse
            cx="11.2212"
            cy="42.8915"
            rx="30.22"
            ry="33.2695"
            transform="rotate(45.6065 11.2212 42.8915)"
            fill="#00B95C"
          />
        </g>
        <g filter={`url(#${id}f4)`}>
          <ellipse
            cx="75.7546"
            cy="104.822"
            rx="29.0177"
            ry="27.943"
            transform="rotate(76.9243 75.7546 104.822)"
            fill="#3186FF"
          />
        </g>
        <g filter={`url(#${id}f5)`}>
          <ellipse
            cx="33.5661"
            cy="35.4043"
            rx="33.5661"
            ry="35.4043"
            transform="matrix(-0.409539 0.912293 -0.912294 -0.409537 101.25 -15.1674)"
            fill="#FBBC04"
          />
        </g>
        <g filter={`url(#${id}f6)`}>
          <path
            d="M2.56802 149.695C-15.8116 142.48 15.5987 83.1163 23.4093 63.2203C31.22 43.3244 52.4514 33.0447 70.831 40.26C89.2107 47.4753 110.996 87.2162 103.185 107.112C95.3742 127.008 20.9477 156.91 2.56802 149.695Z"
            fill="#3186FF"
          />
        </g>
        <g filter={`url(#${id}f7)`}>
          <path
            d="M113.934 75.8079C109.013 81.5509 96.1724 78.6224 85.253 69.2667C74.3335 59.911 69.4704 47.6711 74.391 41.928C79.3116 36.185 92.1525 39.1136 103.072 48.4692C113.991 57.8249 118.855 70.0648 113.934 75.8079Z"
            fill="#749BFF"
          />
        </g>
        <g filter={`url(#${id}f8)`}>
          <ellipse
            cx="92.611"
            cy="23.7962"
            rx="44.2411"
            ry="27.5016"
            transform="rotate(34.0763 92.611 23.7962)"
            fill="#FC413D"
          />
        </g>
        <g filter={`url(#${id}f9)`}>
          <ellipse
            cx="23.4949"
            cy="29.5887"
            rx="23.7071"
            ry="13.7869"
            transform="rotate(112.516 23.4949 29.5887)"
            fill="#FFEE48"
          />
        </g>
      </g>
      <filter
        id={`${id}f0`}
        x="2.49348"
        y="-26.5423"
        width="69.0899"
        height="61.2525"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feGaussianBlur stdDeviation="3.89034" />
      </filter>
      <filter
        id={`${id}f1`}
        x="28.7524"
        y="-32.0333"
        width="135.477"
        height="134.313"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feGaussianBlur stdDeviation="18.8078" />
      </filter>
      <filter
        id={`${id}f2`}
        x="-62.2884"
        y="-21.9253"
        width="142.637"
        height="127.18"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feGaussianBlur stdDeviation="15.9884" />
      </filter>
      <filter
        id={`${id}f3`}
        x="-52.5697"
        y="-20.8346"
        width="127.582"
        height="127.452"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feGaussianBlur stdDeviation="15.9884" />
      </filter>
      <filter
        id={`${id}f4`}
        x="17.3619"
        y="45.4646"
        width="116.786"
        height="118.715"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feGaussianBlur stdDeviation="15.1937" />
      </filter>
      <filter
        id={`${id}f5`}
        x="-7.44765"
        y="-60.4737"
        width="125.303"
        height="122.858"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feGaussianBlur stdDeviation="13.7698" />
      </filter>
      <filter
        id={`${id}f6`}
        x="-27.7086"
        y="13.3597"
        width="157.119"
        height="162.029"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feGaussianBlur stdDeviation="12.297" />
      </filter>
      <filter
        id={`${id}f7`}
        x="50.4638"
        y="16.981"
        width="87.3973"
        height="83.7738"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feGaussianBlur stdDeviation="11.0036" />
      </filter>
      <filter
        id={`${id}f8`}
        x="34.2604"
        y="-28.457"
        width="116.701"
        height="104.506"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feGaussianBlur stdDeviation="9.29385" />
      </filter>
      <filter
        id={`${id}f9`}
        x="-15.1522"
        y="-15.9493"
        width="77.2941"
        height="91.076"
        filterUnits="userSpaceOnUse"
        colorInterpolationFilters="sRGB"
      >
        <feGaussianBlur stdDeviation="11.5027" />
      </filter>
    </>
  );
}

function OpenCodeMark() {
  return (
    <>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
        fill="currentColor"
      />
      <path d="M320 224V352H192V224H320Z" fill="#5A5858" />
    </>
  );
}

/** An ACP agent's own mark, or undefined (its letter badge is drawn instead). */
export function AgentMark({ provider }: { provider: string }) {
  if (provider === "antigravity") return <AntigravityMark />;
  if (provider === "opencode") return <OpenCodeMark />;
  return null;
}
