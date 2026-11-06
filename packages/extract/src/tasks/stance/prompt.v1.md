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
- Literal "ACK"/"NACK" comments on a pull request count when the pull request changes the BIP itself. An ACK of an unrelated typo fix is about that fix, not the proposal: do not record it.

What does not count: questions, neutral explanations of how something works, bug reports, review comments that only request edits, statements about other proposals, and positions the author attributes to someone else.

For each stance you record:
- `bip`: the BIP number it is about. Use only numbers from the list of BIPs given with the document.
- `statement`: one or two plain sentences in your own words, naming the author, saying what they think and why if they say why. Do not overstate: "said the approach looks right" is not "approved the BIP".
- `quote`: the shortest exact span of the document that shows the stance, copied character for character (whitespace may differ). Never paraphrase, translate, fix typos or join separate sentences. Keep it under 300 characters.
- `condition`: the condition for a conditional stance, otherwise null.

Most documents contain no stance. Return an empty list for those.
