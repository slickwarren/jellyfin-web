import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getRelayUrl, PlayerState, RELAY_NAMESPACE, RelayedYoutubePlayer, shouldUseRelay } from './youtubeRelay';

const SERVER = 'https://jellyfin.example:8920';
const RELAY_URL = `${SERVER}/web/assets/youtube/relay.html`;

function messageFrom(source, data) {
    window.dispatchEvent(new MessageEvent('message', { source, data }));
}

describe('shouldUseRelay', () => {
    it('uses the relay for pages loaded from a local file', () => {
        expect(shouldUseRelay('file:')).toBe(true);
    });

    it('embeds directly for pages served over http(s)', () => {
        expect(shouldUseRelay('http:')).toBe(false);
        expect(shouldUseRelay('https:')).toBe(false);
    });
});

describe('getRelayUrl', () => {
    it('builds the relay URL from a server address', () => {
        expect(getRelayUrl(SERVER)).toBe(RELAY_URL);
        expect(getRelayUrl(`${SERVER}/`)).toBe(RELAY_URL);
    });

    it('keeps a base path', () => {
        expect(getRelayUrl('https://example.com/jellyfin')).toBe('https://example.com/jellyfin/web/assets/youtube/relay.html');
    });
});

describe('RelayedYoutubePlayer', () => {
    let events;
    let player;

    beforeEach(() => {
        document.body.innerHTML = '<div id="player"></div>';
        events = { onReady: vi.fn(), onStateChange: vi.fn(), onError: vi.fn() };
        player = new RelayedYoutubePlayer('player', RELAY_URL, { videoId: 'a b&c', width: 640, height: 360, events });
    });

    afterEach(() => {
        player.destroy();
        document.body.innerHTML = '';
    });

    it('replaces the element with an iframe pointing at the relay', () => {
        const iframe = document.getElementById('player');
        expect(iframe.tagName).toBe('IFRAME');
        expect(iframe.src).toBe(`${RELAY_URL}?v=a%20b%26c`);
        expect(iframe.getAttribute('allow')).toContain('autoplay');
        expect(iframe.width).toBe('640');
    });

    it('forwards relay events to the YT-style callbacks', () => {
        const relay = player.iframe.contentWindow;
        messageFrom(relay, { ns: RELAY_NAMESPACE, type: 'state', data: { currentTime: 12.5, duration: 90, volume: 40, muted: true } });
        messageFrom(relay, { ns: RELAY_NAMESPACE, type: 'ready' });
        messageFrom(relay, { ns: RELAY_NAMESPACE, type: 'stateChange', data: PlayerState.PLAYING });
        messageFrom(relay, { ns: RELAY_NAMESPACE, type: 'error', data: 153 });

        expect(events.onReady).toHaveBeenCalledWith({ target: player });
        expect(events.onStateChange).toHaveBeenCalledWith({ target: player, data: PlayerState.PLAYING });
        expect(events.onError).toHaveBeenCalledWith({ target: player, data: 153 });
        expect(player.getCurrentTime()).toBe(12.5);
        expect(player.getDuration()).toBe(90);
        expect(player.getPlayerState()).toBe(PlayerState.PLAYING);
        expect(player.getVolume()).toBe(40);
        expect(player.isMuted()).toBe(true);
    });

    it('ignores messages from other windows or without the relay namespace', () => {
        messageFrom(window, { ns: RELAY_NAMESPACE, type: 'ready' });
        messageFrom(player.iframe.contentWindow, { type: 'ready' });
        expect(events.onReady).not.toHaveBeenCalled();
    });

    it('sends commands to the relay origin and updates state straight away', () => {
        const postMessage = vi.spyOn(player.iframe.contentWindow, 'postMessage').mockImplementation(() => undefined);

        player.playVideo();
        expect(player.getPlayerState()).toBe(PlayerState.PLAYING);
        player.pauseVideo();
        expect(player.getPlayerState()).toBe(PlayerState.PAUSED);
        player.seekTo(30, true);
        expect(player.getCurrentTime()).toBe(30);
        player.setVolume(55);
        player.mute();
        player.stopVideo();

        const origin = SERVER;
        expect(postMessage.mock.calls).toEqual([
            [{ ns: RELAY_NAMESPACE, cmd: 'play', arg: undefined }, origin],
            [{ ns: RELAY_NAMESPACE, cmd: 'pause', arg: undefined }, origin],
            [{ ns: RELAY_NAMESPACE, cmd: 'seek', arg: 30 }, origin],
            [{ ns: RELAY_NAMESPACE, cmd: 'volume', arg: 55 }, origin],
            [{ ns: RELAY_NAMESPACE, cmd: 'mute', arg: true }, origin],
            [{ ns: RELAY_NAMESPACE, cmd: 'stop', arg: undefined }, origin]
        ]);
    });

    it('restores a plain element and stops listening when destroyed', () => {
        const relay = player.iframe.contentWindow;
        player.destroy();

        const placeholder = document.getElementById('player');
        expect(placeholder.tagName).toBe('DIV');
        messageFrom(relay, { ns: RELAY_NAMESPACE, type: 'ready' });
        expect(events.onReady).not.toHaveBeenCalled();
        expect(() => player.playVideo()).not.toThrow();
    });
});
