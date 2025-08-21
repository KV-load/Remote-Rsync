code() {
    FILE="$1"
    # If it's not an absolute path, expand it relative to the current working dir
    case "$FILE" in
        /*) ABS="$FILE" ;;  # already absolute
        *)  ABS="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")" ;;
    esac

      python - "$ABS" <<'PYEND'
import socket, sys, os
s = socket.socket()
s.connect(("localhost", VS_PORT))  # Uses env var PORT
s.send((sys.argv[1] + "\n").encode())
s.close()
PYEND

}