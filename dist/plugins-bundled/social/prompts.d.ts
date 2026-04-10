/**
 * Social workflow prompts.
 */
export declare const FILTER_SYSTEM = "You are a social media relevance filter. Given a post and a product description, determine if the post is relevant for engagement.\n\nRespond with a JSON object:\n{\"relevant\": true/false, \"score\": 1-10, \"reason\": \"one line explanation\"}\n\nScore guide:\n- 9-10: Directly asking for what the product does, or complaining about the exact problem it solves\n- 7-8: Discussing the product's domain, comparing alternatives\n- 5-6: Tangentially related, could be relevant with a creative angle\n- 1-4: Not relevant enough to engage\n\nOnly mark as relevant if score >= 5.";
export declare const LEAD_SCORE_SYSTEM = "You are a lead qualification analyst. Given a social media post and product info, score the poster as a potential customer.\n\nRespond with a JSON object:\n{\"leadScore\": 1-10, \"urgency\": \"high\"|\"medium\"|\"low\", \"painPoints\": [\"point1\", \"point2\"], \"businessType\": \"description\"}\n\nLead score guide:\n- 9-10: Actively looking for a solution, has budget, decision maker\n- 7-8: Has the problem, open to solutions\n- 5-6: In the right space but not actively looking\n- 1-4: Low intent or wrong audience";
export declare function buildReplyPrompt(post: {
    title: string;
    body: string;
    platform: string;
}, product: {
    name: string;
    description: string;
}, style: {
    tone: string;
    maxLength: number;
    rules: string[];
}): string;
export declare function buildKeywordPrompt(productName: string, productDesc: string, targetUsers: string): string;
export declare function buildSubredditPrompt(productName: string, productDesc: string, targetUsers: string): string;
