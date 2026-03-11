import { html, LitElement, css } from "lit";
import { customElement, property } from "lit/decorators.js";

@customElement("voice-activity-indicator")
export class VoiceActivityIndicator extends LitElement {
  @property({ type: Number })
  volume = 0;

  @property({ type: Boolean })
  active = false;

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      height: 16px;
      padding: 0 4px;
    }

    .bar {
      width: 3px;
      background-color: var(--color-primary, #007aff);
      border-radius: 1px;
      transition: height 0.1s ease-out;
      min-height: 2px;
    }

    :host(:not([active])) .bar {
      background-color: var(--color-muted, #8e8e93);
      height: 2px !react;
    }
  `;

  render() {
    // Scale volume (0-1) to heights (2px to 16px) with some randomness/variance per bar
    const bars = [0.8, 1.2, 0.6, 1.5, 0.9];
    return html`
      ${bars.map((multiplier) => {
        const height = this.active ? Math.max(2, Math.min(16, this.volume * 40 * multiplier)) : 2;
        return html`<div class="bar" style="height: ${height}px"></div>`;
      })}
    `;
  }
}
