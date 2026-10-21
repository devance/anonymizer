// Phosphor Light icons (https://phosphoricons.com, MIT) from the Devance design system
// (@devance/design/icons, a copy in packages/design); add new ones in devance/design, light weight only.
import arrowRight from '@devance/design/icons/arrow-right.svg?raw';
import arrowUpRight from '@devance/design/icons/arrow-up-right.svg?raw';
import arrowLeft from '@devance/design/icons/arrow-left.svg?raw';
import moon from '@devance/design/icons/moon.svg?raw';
import sun from '@devance/design/icons/sun.svg?raw';
import lock from '@devance/design/icons/lock-simple.svg?raw';
import lockKey from '@devance/design/icons/lock-key.svg?raw';
import fileUp from '@devance/design/icons/file-arrow-up.svg?raw';
import fileText from '@devance/design/icons/file-text.svg?raw';
import file from '@devance/design/icons/file.svg?raw';
import restore from '@devance/design/icons/arrow-counter-clockwise.svg?raw';
import check from '@devance/design/icons/check.svg?raw';
import checkCircle from '@devance/design/icons/check-circle.svg?raw';
import warning from '@devance/design/icons/warning.svg?raw';
import warningCircle from '@devance/design/icons/warning-circle.svg?raw';
import x from '@devance/design/icons/x.svg?raw';
import trash from '@devance/design/icons/trash.svg?raw';
import download from '@devance/design/icons/download-simple.svg?raw';
import copy from '@devance/design/icons/copy.svg?raw';
import search from '@devance/design/icons/magnifying-glass.svg?raw';
import plus from '@devance/design/icons/plus.svg?raw';
import shieldCheck from '@devance/design/icons/shield-check.svg?raw';
import cpu from '@devance/design/icons/cpu.svg?raw';
import cloudSlash from '@devance/design/icons/cloud-slash.svg?raw';
import code from '@devance/design/icons/code.svg?raw';
import folder from '@devance/design/icons/folder-simple.svg?raw';
import elbow from '@devance/design/icons/arrow-elbow-down-right.svg?raw';
import hourglass from '@devance/design/icons/hourglass-medium.svg?raw';
import memory from '@devance/design/icons/memory.svg?raw';
import sparkle from '@devance/design/icons/sparkle.svg?raw';
import caretDown from '@devance/design/icons/caret-down.svg?raw';
import caretRight from '@devance/design/icons/caret-right.svg?raw';
import hardDrives from '@devance/design/icons/hard-drives.svg?raw';
import paperclip from '@devance/design/icons/paperclip.svg?raw';
import info from '@devance/design/icons/info.svg?raw';
import key from '@devance/design/icons/key.svg?raw';
import folderOpen from '@devance/design/icons/folder-open.svg?raw';
import pause from '@devance/design/icons/pause.svg?raw';

const SVGS = { arrowRight, arrowUpRight, arrowLeft, moon, sun, lock, lockKey, fileUp, fileText, file, restore, check, checkCircle, warning, warningCircle, x, trash, download, copy, search, plus, shieldCheck, cpu, cloudSlash, code, folder, elbow, hourglass, memory, sparkle, caretDown, caretRight, hardDrives, paperclip, info, key, folderOpen, pause };

export type IconName = keyof typeof SVGS;

/** The drawing inside each file (its paths), so the icon renders as one inline svg element. */
const INNER = Object.fromEntries(Object.entries(SVGS).map(([name, svg]) => [name, svg.replace(/^<svg[^>]*>|<\/svg>\s*$/g, '')])) as Record<IconName, string>;

/** An inline icon at 1em, in the current text colour, hidden from screen readers. */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ? `dv-icon ${className}` : 'dv-icon'}
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: INNER[name] }}
    />
  );
}
