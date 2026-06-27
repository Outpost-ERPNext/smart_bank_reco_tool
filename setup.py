from setuptools import setup, find_packages

with open("requirements.txt") as f:
	install_requires = f.read().strip().split("\n")

# get version from __version__ variable in smart_bank_reconciliation/__init__.py
from smart_bank_reconciliation import __version__ as version

setup(
	name="smart_bank_reconciliation",
	version=version,
	description="An app for Auto Bank Reconciliation",
	author="akashnerella@gmail.com",
	author_email="akashnerella@gmail.com",
	packages=find_packages(),
	zip_safe=False,
	include_package_data=True,
	install_requires=install_requires
)
