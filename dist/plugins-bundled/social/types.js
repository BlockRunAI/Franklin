/**
 * Social plugin types — extends WorkflowConfig with social-specific fields.
 */
export const DEFAULT_REPLY_STYLE = {
    tone: 'knowledgeable developer sharing experience',
    maxLengthReddit: 400,
    maxLengthX: 260,
    rules: [
        'Lead with a genuine insight or question about the post',
        'Mention product naturally as "what I use/built" — not as an ad',
        'Never start with "Great post!" or "I agree!"',
        'Sound like a real developer who has faced this problem',
        'If post is not directly relevant, skip — do not force a mention',
    ],
    imageForHighValue: true,
};
