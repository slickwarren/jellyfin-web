import React, { type FC, useCallback, useState } from 'react';

import './BookToc.scss';
import IconButton from '../../../elements/emby-button/IconButton';
import globalize from 'lib/globalize';
import Dialog from '@mui/material/Dialog';

export interface TocItem {
    label?: string;
    href?: string;
    subitems?: TocItem[] | null;
}

interface BookTocProps {
    toc: TocItem[];
    onSelect: (href: string) => void;
    onClose: () => void;
}

const BookToc: FC<BookTocProps> = ({ toc, onSelect, onClose }) => {
    const [active, setActive] = useState(true);

    const onClickClose = useCallback(() => setActive(false), []);

    const onClickChapter = useCallback((chapter: TocItem) => (event: React.MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        if (chapter.href) onSelect(chapter.href);
        setActive(false);
    }, [onSelect]);

    const renderChapter = (chapter: TocItem, index: number): React.JSX.Element => {
        return (
            <li key={`${chapter.href ?? ''}-${index}`}>
                <a href={chapter.href} onClick={onClickChapter(chapter)}>
                    {chapter.label}
                </a>
                {(chapter.subitems?.length ?? 0) > 0 && (
                    <ul style={{ padding: 0 }}>{chapter.subitems?.map(renderChapter)}</ul>
                )}
            </li>
        );
    };

    return (
        <Dialog
            disablePortal
            fullScreen
            className='bookToc'
            open={active}
            onClose={onClickClose}
            slotProps={{ transition: { onExited: onClose } }}
        >
            <div className='bookTocHeader'>
                <IconButton
                    onClick={onClickClose}
                    icon='arrow_back'
                    title={globalize.translate('ButtonClose')}
                />
                <span className='bookTocTitle'>{globalize.translate('TableOfContents')}</span>
            </div>
            <ul className='bookTocList'>
                {toc.map(renderChapter)}
            </ul>
        </Dialog>
    );
};

export default BookToc;
