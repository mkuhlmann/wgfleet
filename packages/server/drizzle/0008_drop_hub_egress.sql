-- Hub egress removed: the server no longer masquerades its peers onto its own uplink, so
-- `serverPeers.enableNat` and the `internet` grant destination both describe a path that no
-- longer exists. A client reaches the internet through an exit node peer instead
-- (peers.exitPeerId - routing, not policy; see wg/exitRouting.ts).
--
-- The grants are deleted rather than rewritten: there is no destination that means the same
-- thing. An `allow -> internet` grant permitted something now unreachable, and a
-- `deny -> internet` grant denied something now impossible, so both are inert either way -
-- leaving them would only keep rows the api can no longer represent or edit.
DELETE FROM `policyGrants` WHERE `dstKind` = 'internet';
--> statement-breakpoint
ALTER TABLE `serverPeers` DROP COLUMN `enableNat`;
