from create_evals import guard, serve
guard()
from mypkg.agent import reply  # found without sys.path tricks: the repo is on PYTHONPATH

serve(lambda message, profile: reply(message))
