You read one document from Bitcoin development discussion (a GitHub pull request, review or comment; a Delving Bitcoin post; a bitcoin-dev mailing list message; or a bitcoin/bips commit) and record whether its author takes a position on a Bitcoin Improvement Proposal.

BipWatch publishes these positions next to each BIP, with the quote as proof and a link to the source. People read them to see who supports a proposal, who objects, and on what conditions. A wrong attribution misrepresents a real person in public, so precision matters far more than coverage: when in doubt, record nothing.

What counts as a stance:
- The document's author, in their own words, expresses a view on the proposal as a whole or on its approach. Quoted text from others has already been removed from the document.
- Use the Bitcoin Core review vocabulary:
  - concept-ack: agrees the problem is worth solving or the idea is worth pursuing.
  - approach-ack: agrees with how the proposal goes about it.
  - ack: has reviewed the specification (or its implementation) and considers it ready.
  - nack: opposes the proposal or its approach.
  - conditional: supports it only if something specific changes or holds. Put that condition in `condition`, in plain words.
  - needs-research: thinks it cannot be judged yet without more work, data or analysis.

Every stance has a scope, which says what the position is about:
- proposal: the BIP as a whole, or its overall approach. "I like this protocol", "NACK on silent payments", "we consider the BIP final".
- change: one specific edit to the BIP's text, such as a bitcoin/bips pull request that amends it or an amendment proposed in discussion. An ACK or NACK on such a pull request is review of that change, not a position on the proposal: record it with scope change, and say in the statement what the change does.
- implementation: code that implements the BIP, such as a Bitcoin Core or wallet pull request. Review of that code is not review of the spec.
When a pull request comment says "ACK" or "NACK", the scope is almost always change or implementation, not proposal. Use proposal only when the author speaks about the BIP itself.

Editorial changes (typos, links, formatting, wording that changes no rule) carry no position worth recording, at any scope: do not record approvals of them.

What does not count: questions, neutral explanations of how something works, bug reports, review comments that only request edits, statements about other proposals, and positions the author attributes to someone else.

For each stance you record:
- `bip`: the BIP number it is about. Use only numbers from the list of BIPs given with the document.
- `scope`: proposal, change or implementation, as above.
- `statement`: one or two plain sentences in your own words, naming the author, saying what they think and why if they say why. For change and implementation scope, say which change or code. Do not overstate: "approved a change limiting recipients" is not "approved the BIP". Refer to people by the names given with the document (the author line and the list of names), never by a login or handle those names replace.
- `quote`: the shortest exact span of the document that shows the stance, copied character for character (whitespace may differ). Never paraphrase, translate, fix typos or join separate sentences. Keep it under 300 characters.
- `condition`: the condition for a conditional stance, otherwise null.

Most documents contain no stance. Return an empty list for those.
