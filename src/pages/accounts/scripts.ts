/*
 * Scripts the Accounts page runs on the host.
 *
 * LISTER and LASTLOG2_PY are upstream's files verbatim (cockpit 356
 * pkg/users/ssh-list-public-keys.sh and pkg/lib/lastlog2.py), so their
 * behaviour -- and their quirks -- stay exactly what the web console does on
 * the same machine. ADDER is upstream's ssh-add-public-key.sh made safe to
 * run in a home directory someone else controls (see there).
 *
 * SPDX-License-Identifier: LGPL-2.1-or-later (the upstream scripts)
 */

/*
 * Reads authorized_keys content on stdin; for every key line prints
 * ssh-keygen's fingerprint line and then the key line itself. Comment lines
 * and blank lines are skipped. Runs unprivileged: it only ever sees what the
 * page passes it.
 */
export const LISTER = `#!/bin/sh
# SPDX-License-Identifier: LGPL-2.1-or-later

dir=$(mktemp -d)
cd "$dir"

process()
{
    if [ -z "$1" ]; then
        return
    fi
    case "$1" in
    \\#*)
        ;;
    *)
        echo "$1"> authorized_keys
        echo "$(LC_ALL=C ssh-keygen -l -f authorized_keys)"
        echo "$1"
        ;;
    esac
}

sed -e '$a\\' | while read -r line; do
    process "$line"
done

rm -f "$dir/authorized_keys"
rmdir "$dir"
`;

/*
 * Appends the key on stdin to $1/.ssh/authorized_keys, creating the
 * directory and the file as needed. It must run AS THE ACCOUNT whose home $1
 * is (actions.ts addKey(): runuser for someone else's account).
 *
 * Upstream's ssh-add-public-key.sh runs as root ("try" with administrative
 * access) and chowns what it made: in a home directory the account owns,
 * a planted symlink (~/.ssh -> /root/.ssh, or authorized_keys -> any file)
 * then has root chown and append to the link's target -- a way to root for
 * any user an admin adds a key for. As the account itself every step only
 * reaches what the account could reach anyway, and nothing needs chown.
 * umask 077: a new .ssh is 0700 and a new authorized_keys 0600, which
 * sshd's StrictModes wants; upstream left the directory to the umask.
 */
export const ADDER = `#!/bin/sh
# SPDX-License-Identifier: LGPL-2.1-or-later

set -euf
umask 077
mkdir -p "$1/.ssh"
cd "$1/.ssh"

touch authorized_keys
sed -i -e '$a\\' authorized_keys
cat >> authorized_keys

chmod 600 authorized_keys
`;

/* pkg/lib/python.ts: run a Python script with the platform's interpreter. */
export const PYTHON_INVOKE: readonly string[] = [
    "sh", "-ec", "exec $(command -v /usr/libexec/platform-python || command -v python3) -c \"$@\"", "--",
];

/* Prints the lastlog2 database as JSON; exits 1 when the system does not use lastlog2. */
export const LASTLOG2_PY = `# SPDX-License-Identifier: LGPL-2.1-or-later
# Print lastlog2 database as JSON; used in ./login.js
import json
import os
import sqlite3
import sys

DB = "/var/lib/lastlog/lastlog2.db"

if not os.path.exists(DB):
    sys.exit(f"{DB} does not exist")

con = sqlite3.connect(DB)
cur = con.cursor()
query = "SELECT Name, Time, TTY, RemoteHost FROM Lastlog2"
if len(sys.argv) == 2:
    res = cur.execute(query + " WHERE Name = ?", [sys.argv[1]])
else:
    res = cur.execute(query)
users = {}
for [name, time, tty, host] in res:
    users[name] = {"time": time, "tty": tty, "host": host}
print(json.dumps(users))
`;

/*
 * Lock state without passwd --all (RHEL's libuser passwd has no --all).
 *
 * Upstream falls back to reading all of /etc/shadow into the page and
 * checking which hashes start with "!". This prints, as root on the host,
 * each account's name and only the FIRST character of its password field,
 * which is all that rule needs: no password hash ever leaves the machine.
 * Plain POSIX sh, no external programs; "|| [ -n ... ]" keeps a last line
 * that lacks its newline.
 */
export const SHADOW_LOCK_SCRIPT =
    "while IFS=: read -r name hash rest || [ -n \"$name\" ]; do printf '%s %.1s\\n' \"$name\" \"$hash\"; done < /etc/shadow";
