from setuptools import setup, find_packages

setup(
    name='sdominanta-mcp',
    version='0.2.0',
    description='Sdominanta.net Multi-Agent Control Plane and Pa2ap Bridge',
    author='Sdominanta Project',
    packages=find_packages(where='.'),
    package_dir={'': '.'},
    install_requires=[
        'mcp[cli]>=1.2.0',
        'jsonschema>=4.19.0',
        'PyNaCl>=1.5.0',
        'rfc8785>=0.1.1',
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
            'sdom-mcp=mcp.main:main',
            'sdom-bridge=bridge.main:app'
        ],
    },
    include_package_data=True,
    package_data={
        '': [
            '.env.template',
            'bridge/config.yaml',
            'seed/bootstrap.json',
            'seed/topics.json',
            'seed/agents_registry.json',
            'wall/WALL_NOTE.schema.json',
            'wall/WALL_RULES.md',
            'wall/threads/*',
            'docs/*',
            'pa2ap/daemon/*',
            'examples/*',
            'docker/*',
            '.github/workflows/*',
        ]
    },
)
