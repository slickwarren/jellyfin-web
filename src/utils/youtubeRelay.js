/**
 * YouTube refuses to play embedded videos when the embedding page sends no Referer
 * (error 153, "Video player configuration error"). Clients that load the web client from a
 * local file (Tizen, webOS) never send one, so for them the YouTube player runs inside
 * assets/youtube/relay.html, served by the Jellyfin server over http(s), and is driven over
 * postMessage.
 *
 * RelayedYoutubePlayer stands in for YT.Player: it exposes the subset of its API that the
 * YouTube trailer plugin uses, and calls the same event callbacks.
 */

export const RELAY_NAMESPACE = 'jellyfin-youtube-relay';
export const RELAY_PATH = 'web/assets/youtube/relay.html';

/** Same values as YT.PlayerState, which is not loaded on the page when the relay is used. */
export const PlayerState = {
    UNSTARTED: -1,
    ENDED: 0,
    PLAYING: 1,
    PAUSED: 2
};

/** Pages served over http(s) send a Referer themselves and can embed YouTube directly. */
export function shouldUseRelay(protocol = window.location.protocol) {
    return protocol !== 'http:' && protocol !== 'https:';
}

/** URL of the relay page on the given server address (which may include a base path). */
export function getRelayUrl(serverAddress) {
    const base = serverAddress.endsWith('/') ? serverAddress : serverAddress + '/';
    return new URL(RELAY_PATH, base).href;
}

export class RelayedYoutubePlayer {
    /**
     * @param {string} elementId - id of the element to replace with the relay iframe
     * @param {string} relayUrl - absolute URL of relay.html on the Jellyfin server
     * @param {object} options - the options object YT.Player would take (videoId, width, height, events)
     */
    constructor(elementId, relayUrl, options) {
        this.events = options.events || {};
        this.relayOrigin = new URL(relayUrl).origin;
        this.state = {
            currentTime: 0,
            duration: 0,
            playerState: PlayerState.UNSTARTED,
            volume: 100,
            muted: false
        };

        const iframe = document.createElement('iframe');
        iframe.id = elementId;
        iframe.src = `${relayUrl}?v=${encodeURIComponent(options.videoId)}`;
        iframe.width = options.width;
        iframe.height = options.height;
        iframe.setAttribute('allow', 'autoplay; encrypted-media');
        iframe.setAttribute('frameborder', '0');
        iframe.style.border = '0';
        document.getElementById(elementId).replaceWith(iframe);
        this.iframe = iframe;

        this.onMessage = this.onMessage.bind(this);
        window.addEventListener('message', this.onMessage);
    }

    onMessage(e) {
        if (!this.iframe || e.source !== this.iframe.contentWindow || e.data?.ns !== RELAY_NAMESPACE) {
            return;
        }

        const { type, data } = e.data;
        switch (type) {
            case 'state':
                Object.assign(this.state, data);
                break;
            case 'ready':
                this.events.onReady?.({ target: this });
                break;
            case 'stateChange':
                this.state.playerState = data;
                this.events.onStateChange?.({ target: this, data });
                break;
            case 'error':
                this.events.onError?.({ target: this, data });
                break;
            default:
                break;
        }
    }

    send(cmd, arg) {
        this.iframe?.contentWindow?.postMessage({ ns: RELAY_NAMESPACE, cmd, arg }, this.relayOrigin);
    }

    // State changes below are applied locally straight away, so that synchronous getters
    // (paused(), currentTime()) reflect a command before the relay's next state report.

    playVideo() {
        this.state.playerState = PlayerState.PLAYING;
        this.send('play');
    }

    pauseVideo() {
        this.state.playerState = PlayerState.PAUSED;
        this.send('pause');
    }

    stopVideo() {
        this.send('stop');
    }

    seekTo(seconds) {
        this.state.currentTime = seconds;
        this.send('seek', seconds);
    }

    setVolume(volume) {
        this.state.volume = volume;
        this.send('volume', volume);
    }

    mute() {
        this.state.muted = true;
        this.send('mute', true);
    }

    unMute() {
        this.state.muted = false;
        this.send('mute', false);
    }

    getCurrentTime() {
        return this.state.currentTime;
    }

    getDuration() {
        return this.state.duration;
    }

    getPlayerState() {
        return this.state.playerState;
    }

    getVolume() {
        return this.state.volume;
    }

    isMuted() {
        return this.state.muted;
    }

    setSize(width, height) {
        if (this.iframe) {
            this.iframe.width = width;
            this.iframe.height = height;
        }
    }

    /** Like YT.Player.destroy(): removes the iframe and puts back a plain element with the same id. */
    destroy() {
        window.removeEventListener('message', this.onMessage);
        if (this.iframe) {
            const placeholder = document.createElement('div');
            placeholder.id = this.iframe.id;
            this.iframe.replaceWith(placeholder);
            this.iframe = null;
        }
    }
}
