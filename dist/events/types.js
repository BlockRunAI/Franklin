import crypto from 'node:crypto';
export function makeEvent(props) {
    return {
        id: crypto.randomUUID(),
        ts: new Date().toISOString(),
        ...props,
    };
}
