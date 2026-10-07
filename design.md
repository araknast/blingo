# blingo

this is a design sketch for blingo, an agent-based change control and
management system built on cloudflare.

blingo is built on cloudflare artifacts

blingo is based around repositories. each repository consists of zero or more
huddles (only a repository with no files can have zero huddles). 

## huddles
a huddle is a set of repository forks in which no fork changes the same file. each huddle has a set representitive.

each huddle also stores a set of which files have been changed by a huddle
member. this way an agent can easily determine whether its fork can be placed
in a particular huddle.


when an agent wants to change the repository, it creates a fork, then when its
done, it finds a huddle to place the fork in.  if there is no available huddle
(i.e. the fork changes files that are changed by members of every other
huddle), then the fork becomes the only member of a new huddle.


each huddle has a distance to each other huddle. the distance from huddle a to
huddle b is the number of files changed in huddle b that are also changed in
huddle a. if the distance between two huddles is 0, they should immediately be
merged (set join).

## merging huddles

the huddle representative should constantly be merging its set members into
itself. once a member fork is merged, it is marked as such,  and the artifact
is deleted, but the fork is permanently considered part of the huddle, and the
diff is kept.

if all members of a huddle have been successfully merged, the representative
should try to merge with its nearest neighbor, determined using the distance
calculation above. While the merge is being attempted both the huddle and its
neighbor should be invisible to agents looking to place a fork until the merge
has either failed or completed successfully.

if the merge completes successfully, the two huddles should be joined into one
set.  if the merge fails, the huddles should be marked as conflicting, and no
further attempt to merge them should be made. attempts to merge with other
huddles that have not been marked as conflicting can still be made, taking into
consideration the neares-neighbor rule from earlier.

a scenario may occur where huddle A has been created, then huddle B
with distance 0 becomes visible to it (i.e. huddle B failed to merge with
another huddle). In this case, huddle A should be merged with huddle B.

all merges should be done using a git rebase

## interaction
the main method of interacting with blingo is spawning an agent to do some
work on a fork. The user inputs a prompt and optionally a huddle tobase the
fork on. If no fork is specified, a new repository is created.

alternatively, the user can spawn a "notagent" which functions exactly like a
remote git repository, but only accepts a single push request. The notagent
inteacts with the blingo system in the same way an agent would, except instead
of generating code itself, it waits for a git push. Once it receives this, it
shuts down the git sever and places the fork in a huddle in the same way an
agent would.
