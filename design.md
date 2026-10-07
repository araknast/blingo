# blingo

this is a design sketch for blingo, an agent-based change control and
management system built on cloudflare.

blingo is built on cloudflare artifacts

blingo is based around repositories. each repository consists of zero or more
bubbles (only a repository with no files can have zero bubbles). 

## bubbles
a bubble is a set of repository forks in which no fork changes the same file. each bubble has a set representitive.

each bubble also stores a set of which files have been changed by a bubble
member. this way an agent can easily determine whether its fork can be placed
in a particular bubble.


when an agent wants to change the repository, it creates a fork, then when its
done, it finds a bubble to place the fork in.  if there is no available bubble
(i.e. the fork changes files that are changed by members of every other
bubble), then the fork becomes the only member of a new bubble.


each bubble has a distance to each other bubble. the distance from bubble a to
bubble b is the number of files changed in bubble b that are also changed in
bubble a. if the distance between two bubbles is 0, they should immediately be
merged (set join).

## merging bubbles

the bubble representative should constantly be merging its set members into
itself. once a member fork is merged, it is marked as such,  and the artifact
is deleted, but the fork is permanently considered part of the bubble, and the
diff is kept.

if all members of a bubble have been successfully merged, the representative
should try to merge with its nearest neighbor, determined using the distance
calculation above. While the merge is being attempted both the bubble and its
neighbor should be invisible to agents looking to place a fork until the merge
has either failed or completed successfully.

if the merge completes successfully, the two bubbles should be joined into one
set.  if the merge fails, the bubbles should be marked as conflicting, and no
further attempt to merge them should be made. attempts to merge with other
bubbles that have not been marked as conflicting can still be made, taking into
consideration the neares-neighbor rule from earlier.

a scenario may occur where bubble A has been created, then bubble B
with distance 0 becomes visible to it (i.e. bubble B failed to merge with
another bubble). In this case, bubble A should be merged with bubble B.

all merges should be done using a git rebase

## interaction
the main method of interacting with blingo is spawning an agent to do some
work on a fork. The user inputs a prompt and optionally a bubble tobase the
fork on. If no fork is specified, a new repository is created.

alternatively, the user can spawn a "notagent" which functions exactly like a
remote git repository, but only accepts a single push request. The notagent
inteacts with the blingo system in the same way an agent would, except instead
of generating code itself, it waits for a git push. Once it receives this, it
shuts down the git sever and places the fork in a bubble in the same way an
agent would.
