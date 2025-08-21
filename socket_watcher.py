import socket
import random
import sys

HOST = "0.0.0.0"
PORT = None

def get_free_port_above(min_port=4000, max_port=65535):
    while True:
        port = random.randint(min_port, max_port)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((HOST, port))
                return port
            except OSError:
                continue  # port is busy, try again

PORT = get_free_port_above(4000)

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
    command_file = sys.argv[1];
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind((HOST, PORT))
    s.listen(5)
    print(PORT, flush=True)

    while True:
        conn, addr = s.accept()
        with conn:
            print("Connected by", addr)
            data = conn.recv(1024).decode()
            if data:
                with open(command_file, "w") as f:
                    f.write(data + "\n")
