<<<<<<< HEAD
from setuptools import setup, find_packages

setup(
    name='sdominanta-mcp',
    version='0.2.0',
    description='Sdominanta.net Multi-Agent Control Plane and Pa2ap Bridge',
    author='Sdominanta Project',
    packages=find_packages(where='.', include=['Sdominanta.net*']),
    package_dir={'Sdominanta.net': 'Sdominanta.net'},
    install_requires=[
        'fastapi',
        'uvicorn',
        'python-multipart',
        'websockets',
        'PyYAML',
        'python-dotenv',
        'httpx',
    ],
    entry_points={
        'console_scripts': [
            'sdom-mcp=Sdominanta.net.mcp.main:main',
            'sdom-bridge=Sdominanta.net.bridge.main:app' 
        ],
    },
    include_package_data=True,
    package_data={'Sdominanta.net': ['mcp/tools/*.py']},
)
=======
from setuptools import setup

setup()
>>>>>>> 5d32ff69f52fcbea317316afcc875fb4a2ef2fe9
