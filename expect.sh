#!/usr/bin/expect -f

# Usage: ./ssh-copy-id-expect.sh <user@host> <path_to_private_key> <password>

set userHost [lindex $argv 0]
set keyPath [lindex $argv 1]   ;# private key
set password [lindex $argv 2]

# Copy public key
spawn ssh-copy-id -f -i ${keyPath} $userHost
expect {
    -re "(?i)yes/no" {
        send "yes\r"
        exp_continue
    }
    -re "(?i)password:" {
        send "$password\r"
        exp_continue
    }
    eof {
        # Done
    }
}

# Verify
spawn ssh -o StrictHostKeyChecking=no -i $keyPath $userHost "echo OK"
expect {
    -re "OK" {
        send_user "SSH key installed successfully.\n"
    }
    eof {
        send_user "Failed to verify SSH key.\n"
        exit 1
    }
}
