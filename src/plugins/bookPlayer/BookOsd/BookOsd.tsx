import React, { type FC, useCallback, useEffect, useRef, useState } from 'react';

import './BookOsd.scss';
import IconButton from '../../../elements/emby-button/IconButton';
import globalize from 'lib/globalize';
import * as userSettings from '../../../scripts/settings/userSettings';
import type { BaseItemDto } from '@jellyfin/sdk/lib/generated-client';
import Screenfull from 'screenfull';

interface BookOsdProps {
    item: BaseItemDto;
    onExit: () => void;
    onPrevious: () => void;
    onNext: () => void;
    onOpenTableOfContents?: () => void;
    onRotateTheme?: () => void;
    onDecreaseFontSize?: () => void;
    onIncreaseFontSize?: () => void;
    onToggleDirection?: () => void;
    onToggleLayout?: () => void;
    onToggleFullscreen?: () => void;
    readAloudEvents?: EventTarget;
    initialReadAloudRate?: number;
    onReadAloud?: (anchor: HTMLElement) => void;
    onReadAloudToggle?: () => void;
    onReadAloudStop?: () => void;
    onReadAloudPrevious?: () => void;
    onReadAloudNext?: () => void;
    onReadAloudRate?: (anchor: HTMLElement) => void;
}

interface ReadAloudChange {
    state: 'idle' | 'playing' | 'paused';
    rate: number;
}

interface ComicsPlayerSettings {
    langDir?: string;
    pagesPerView?: number;
}

const BookOsd: FC<BookOsdProps> = ({
    item,
    onExit,
    onPrevious,
    onNext,
    onOpenTableOfContents,
    onRotateTheme,
    onDecreaseFontSize,
    onIncreaseFontSize,
    onToggleDirection,
    onToggleLayout,
    onToggleFullscreen,
    readAloudEvents,
    initialReadAloudRate = 1,
    onReadAloud,
    onReadAloudToggle,
    onReadAloudStop,
    onReadAloudPrevious,
    onReadAloudNext,
    onReadAloudRate
}) => {
    const settings = userSettings.getComicsPlayerSettings(item.Id!) as ComicsPlayerSettings;
    const timeout = useRef<ReturnType<typeof setTimeout>>();

    const [direction, setDirection] = useState(settings.langDir === 'rtl');
    const [layout, setLayout] = useState(settings.pagesPerView === 2);
    const [fullscreen, setFullscreen] = useState(false);
    const [visible, setVisible] = useState(true);
    const [readAloud, setReadAloud] = useState<ReadAloudChange>({ state: 'idle', rate: initialReadAloudRate });

    const scheduleHide = useCallback(() => {
        clearTimeout(timeout.current);
        timeout.current = setTimeout(() => setVisible(false), 2000);
    }, []);

    const updateFullscreen = useCallback((state: boolean) => {
        if (Screenfull.isEnabled && Screenfull.isFullscreen !== state) {
            void Screenfull.toggle();
        } else if (window.NativeShell) {
            state ? window.NativeShell.enableFullscreen?.() : window.NativeShell.disableFullscreen?.();
        }
    }, []);

    const onClickDirection = useCallback(() => {
        onToggleDirection?.();
        setDirection(state => !state);
    }, [onToggleDirection]);

    const onClickLayout = useCallback(() => {
        onToggleLayout?.();
        setLayout(state => !state);
    }, [onToggleLayout]);

    const onClickReadAloud = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        onReadAloud?.(event.currentTarget);
    }, [onReadAloud]);

    const onClickReadAloudRate = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        onReadAloudRate?.(event.currentTarget);
    }, [onReadAloudRate]);

    useEffect(() => {
        if (!readAloudEvents) return;
        const onChange = (event: Event) => setReadAloud((event as CustomEvent<ReadAloudChange>).detail);
        readAloudEvents.addEventListener('change', onChange);
        return () => readAloudEvents.removeEventListener('change', onChange);
    }, [readAloudEvents]);

    const onClickFullscreen = useCallback(() => {
        updateFullscreen(!fullscreen);
        onToggleFullscreen?.();
        setFullscreen(state => !state);
    }, [onToggleFullscreen, updateFullscreen, fullscreen]);

    useEffect(() => {
        const onPointerMove = (event: PointerEvent) => {
            if (event.pointerType !== 'mouse') return;

            scheduleHide();
            setVisible(true);
        };

        const onClick = (event: MouseEvent) => {
            // apply this before the BookOsd check so IconButton clicks will reset the timer
            scheduleHide();

            if ((event.target as Element | null)?.closest?.('.bookOsdRow, .bookReadAloudBar')) return;
            setVisible(state => !state);
        };

        scheduleHide();
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('click', onClick);

        return () => {
            clearTimeout(timeout.current);
            updateFullscreen(false);
            document.removeEventListener('pointermove', onPointerMove);
            document.removeEventListener('click', onClick);
        };
    }, [scheduleHide, updateFullscreen]);

    return (
        <div className='bookOsd'>
            <div className='bookOsdRow' style={{ paddingTop: 'env(safe-area-inset-top)', ...(!visible && { opacity: 0, pointerEvents: 'none' }) }}>
                <IconButton onClick={onExit} icon='arrow_back' title={globalize.translate('ButtonBack')} />
                <span className='bookOsdTitle'>{item.Name}</span>
            </div>

            <div className='bookOsdRow' style={{ paddingBottom: 'env(safe-area-inset-bottom)', ...(!visible && { opacity: 0, pointerEvents: 'none' }) }}>
                <IconButton onClick={onPrevious} icon='navigate_before' title={globalize.translate('Previous')} />
                <IconButton onClick={onNext} icon='navigate_next' title={globalize.translate('Next')} />
                <div className='bookOsdSpacer' />

                {onOpenTableOfContents && (
                    <IconButton
                        onClick={onOpenTableOfContents}
                        icon='toc'
                        title={globalize.translate('TableOfContents')}
                    />
                )}

                {onReadAloud && (
                    <IconButton
                        onClick={onClickReadAloud}
                        icon='record_voice_over'
                        title={globalize.translate('ReadAloud')}
                    />
                )}

                {onRotateTheme && (
                    <IconButton
                        onClick={onRotateTheme}
                        icon='remove_red_eye'
                        title={globalize.translate('LabelTheme')}
                    />
                )}

                {onDecreaseFontSize && (
                    <IconButton
                        onClick={onDecreaseFontSize}
                        icon='text_decrease'
                        title={globalize.translate('Smaller')}
                    />
                )}

                {onIncreaseFontSize && (
                    <IconButton
                        onClick={onIncreaseFontSize}
                        icon='text_increase'
                        title={globalize.translate('Larger')}
                    />
                )}

                {onToggleDirection && (
                    <IconButton
                        onClick={onClickDirection}
                        icon={direction ? 'arrow_circle_left' : 'arrow_circle_right'}
                        title={globalize.translate(direction ? 'ViewRightToLeft' : 'ViewLeftToRight')}
                    />
                )}

                {onToggleLayout && (
                    <IconButton
                        onClick={onClickLayout}
                        icon={layout ? 'import_contacts' : 'devices_fold'}
                        title={globalize.translate(layout ? 'ViewDoublePage' : 'ViewSinglePage')}
                    />
                )}

                {(Screenfull.isEnabled || window.NativeShell) && (
                    <IconButton
                        onClick={onClickFullscreen}
                        icon={fullscreen ? 'fullscreen_exit' : 'fullscreen'}
                        title={globalize.translate(fullscreen ? 'ExitFullscreen' : 'Fullscreen')}
                    />
                )}
            </div>

            {readAloud.state !== 'idle' && (
                <div className={visible ? 'bookReadAloudBar bookReadAloudBarRaised' : 'bookReadAloudBar'}>
                    <IconButton
                        onClick={onReadAloudPrevious}
                        icon='skip_previous'
                        title={globalize.translate('ReadAloudPreviousParagraph')}
                    />
                    <IconButton
                        onClick={onReadAloudToggle}
                        icon={readAloud.state === 'playing' ? 'pause' : 'play_arrow'}
                        title={globalize.translate(readAloud.state === 'playing' ? 'ButtonPause' : 'Play')}
                    />
                    <IconButton
                        onClick={onReadAloudNext}
                        icon='skip_next'
                        title={globalize.translate('ReadAloudNextParagraph')}
                    />
                    <button
                        type='button'
                        className='bookReadAloudRate'
                        onClick={onClickReadAloudRate}
                        title={globalize.translate('PlaybackRate')}
                    >
                        {`${readAloud.rate}x`}
                    </button>
                    <IconButton
                        onClick={onReadAloudStop}
                        icon='stop'
                        title={globalize.translate('ButtonStop')}
                    />
                </div>
            )}
        </div>
    );
};

export default BookOsd;
